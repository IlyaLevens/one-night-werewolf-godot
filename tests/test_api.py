"""Несколько независимых клиентов: авторизация, изоляция лобби и полный раунд."""
import unittest

from app import create_app
from werewolf.game import GameService
from tests.test_game import Clock


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.clock=Clock()
        self.game=GameService(self.clock)
        self.app=create_app(self.game)
        self.app.testing=True
        self.client=self.app.test_client()
        self.credentials=[]
        created=self.client.post('/api/rooms',json={'name':'Host'}).get_json()
        self.code=created['code']
        self.credentials.append(created)
        for name in ['Guest1','Guest2']:
            self.credentials.append(self.client.post(f'/api/rooms/{self.code}/join',json={'name':name}).get_json())

    def auth(self,i):
        return {'Authorization':'Bearer '+self.credentials[i]['token']}

    def view(self,i=0):
        return self.client.get(f'/api/rooms/{self.code}',headers=self.auth(i)).get_json()

    def post(self,i,action,**data):
        return self.client.post(f'/api/rooms/{self.code}/{action}',headers=self.auth(i),json={'stage':self.view(i)['stage'],**data})

    def start(self):
        for i in range(3):
            self.assertEqual(self.post(i,'ready').status_code,200)
        self.assertEqual(self.post(0,'start').status_code,200)

    def test_static_routes_and_headers(self):
        for url in ['/', '/static/app.js', '/static/style.css', '/static/moon.svg','/health','/api/roles']:
            response=self.client.get(url)
            self.assertEqual(response.status_code,200)
            self.assertEqual(response.headers['Cache-Control'],'no-store')
            self.assertIn("frame-ancestors 'none'",response.headers['Content-Security-Policy'])
            response.close()

    def test_token_required(self):
        response=self.client.get(f'/api/rooms/{self.code}')
        self.assertEqual(response.status_code,401)
        response=self.client.get(f'/api/rooms/{self.code}',headers={'Authorization':'Bearer invalid'})
        self.assertEqual(response.status_code,401)
        response=self.client.get(f'/api/rooms/{self.code}',headers={'Authorization':'Bearer не-токен'})
        self.assertEqual(response.status_code,401)

    def test_token_from_another_lobby_rejected(self):
        other=self.client.post('/api/rooms',json={'name':'Other'}).get_json()
        response=self.client.get(f'/api/rooms/{self.code}',headers={'Authorization':'Bearer '+other['token']})
        self.assertEqual(response.status_code,401)

    def test_host_cannot_see_other_roles_or_center(self):
        self.start()
        for i in range(3):
            view=self.view(i)
            self.assertIsNotNone(view['me']['original'])
            self.assertIsNone(view['result'])
            for forbidden in ['center','original_center','history','acted']:
                self.assertNotIn(forbidden,view)
            for p in view['players']:
                for forbidden in ['card','original','notes','token','vote','action_done']:
                    self.assertNotIn(forbidden,p)
            self.assertNotIn('token',view['me'])

    def test_join_during_round_rejected(self):
        self.start()
        self.assertEqual(self.client.post(f'/api/rooms/{self.code}/join',json={'name':'Late'}).status_code,409)

    def test_names_validated_and_duplicates_blocked(self):
        for name in ['', 'x'*25, None, ['name']]:
            self.assertEqual(self.client.post('/api/rooms',json={'name':name}).status_code,400)
        self.assertEqual(self.client.post(f'/api/rooms/{self.code}/join',json={'name':'host'}).status_code,400)

    def test_invalid_json_and_body_size(self):
        self.assertEqual(self.client.post('/api/rooms',json=[]).status_code,400)
        self.assertEqual(self.client.post('/api/rooms',data='not json',content_type='application/json').status_code,400)
        self.assertEqual(self.client.post('/api/rooms',data='x'*9000,content_type='application/json').status_code,413)

    def test_unauthorized_settings(self):
        self.assertEqual(self.post(1,'settings',automatic=True).status_code,403)

    def test_get_requests_do_not_reveal_vote_targets(self):
        self.start()
        room=self.game.rooms[self.code]
        room.phase,room.deadline='voting',self.clock()+45
        target=self.view(1)['me']['id']
        self.assertEqual(self.post(0,'vote',target=target).status_code,200)
        self.assertIsNone(self.view(2)['result'])
        self.assertEqual(self.view(0)['me']['vote'],target)
        self.assertIsNone(self.view(2)['me']['vote'])

    def test_reconnect_same_token_same_identity(self):
        self.start()
        new_client=self.app.test_client()
        view=new_client.get(f'/api/rooms/{self.code}',headers=self.auth(1)).get_json()
        self.assertEqual(view['me'],self.view(1)['me'])

    def test_full_http_round_and_rematch(self):
        self.start()
        for i in range(3):
            self.post(i,'ready')
        room=self.game.rooms[self.code]
        while room.phase=='night':
            self.clock.now=room.deadline
            self.view()
        self.assertEqual(self.view()['phase'],'discussion')
        self.assertEqual(self.post(1,'chat',message='Кем вы были?').status_code,200)
        self.assertEqual(len(self.view(2)['chat']),1)
        self.post(0,'begin_vote')
        ids=[self.view(i)['me']['id'] for i in range(3)]
        for i in range(3):
            self.assertEqual(self.post(i,'vote',target=ids[(i+1)%3]).status_code,200)
        result=self.view()['result']
        self.assertEqual(len(result['center']),3)
        self.assertTrue(all(p['original'] and p['role'] for p in result['players']))
        self.assertEqual(self.view()['phase'],'results')
        self.post(0,'reset')
        self.assertIsNone(self.view()['me']['original'])
        self.assertEqual(self.view()['phase'],'lobby')
        self.start()
        self.assertEqual(self.view()['round'],2)

    def test_leave_transfers_host_and_kick_invalidates_token(self):
        second_id=self.view(1)['me']['id']
        self.assertEqual(self.post(0,'leave').status_code,200)
        self.assertEqual(self.view(1)['host'],second_id)
        third_id=self.view(2)['me']['id']
        self.assertEqual(self.post(1,'kick',target=third_id).status_code,200)
        self.assertEqual(self.client.get(f'/api/rooms/{self.code}',headers=self.auth(2)).status_code,401)

    def test_chat_html_is_data_not_rendered_server_markup(self):
        message='<img src=x onerror=alert(1)>'
        self.assertEqual(self.post(0,'chat',message=message).status_code,200)
        self.assertEqual(self.view(1)['chat'][0]['text'],message)
        self.assertNotIn(message,self.client.get('/').get_data(as_text=True))


if __name__=='__main__':
    unittest.main()
