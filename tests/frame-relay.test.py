import importlib.util
from pathlib import Path
import unittest
import json
from unittest.mock import Mock
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('relay',Path(__file__).resolve().parents[1]/'scripts/frame-relay.py')
relay=importlib.util.module_from_spec(spec);spec.loader.exec_module(relay)
class FakeTV:
    def __init__(self):self.ids={'MY_F0042','MY_F0043'};self.deleted=[];self.current='MY_F0042';self.rotation='10';self.shuffle=True;self.artmode='on'
    def get_api_version(self):return '0.97'
    def available(self,*a):return [{'content_id':i} for i in self.ids]
    def delete(self,cid):self.deleted.append(cid);self.ids.remove(cid);return True
    def get_auto_rotation_status(self):return {'value':self.rotation,'category_id':'MY-C0002'}
    def set_auto_rotation_status(self,duration,type,category):self.rotation=str(duration) if duration else 'off';self.shuffle=type
    def select_image(self,cid,show=True):self.current=cid;self.rotation='off'
    def get_current(self):return {'content_id':self.current}
    def get_artmode(self):return self.artmode
    def close(self):pass
class RelayTests(unittest.TestCase):
    def setUp(self):relay.FAST=None;relay.FAST_DUE=0;relay.config.clear()
    def test_show_restores_native_rotation(self):
        tv=FakeTV()
        with patch.object(relay,'tv',return_value=tv),patch.object(relay,'request'),patch.object(relay,'mapping',return_value={}):
            relay.execute({'action':'slideshow','minutes':10,'shuffle':False})
            relay.execute({'action':'show','contentId':'MY_F0043'})
        self.assertEqual(tv.current,'MY_F0043');self.assertEqual(tv.rotation,'10');self.assertFalse(tv.shuffle)
    def test_show_does_not_start_stopped_rotation(self):
        tv=FakeTV();tv.rotation='off'
        with patch.object(relay,'tv',return_value=tv),patch.object(relay,'request'),patch.object(relay,'mapping',return_value={}):
            relay.execute({'action':'show','contentId':'MY_F0043'})
        self.assertEqual(tv.rotation,'off')
    def test_fast_tick_stop_and_native_switch(self):
        tv=FakeTV()
        with patch.object(relay,'tv',return_value=tv),patch.object(relay,'request'),patch.object(relay,'mapping',return_value={}):
            relay.execute({'action':'fast_slideshow','seconds':30,'shuffle':True})
            self.assertEqual(tv.rotation,'off')
            relay.FAST_DUE=0;relay.fast_tick();self.assertEqual(tv.current,'MY_F0043')
            relay.execute({'action':'show','contentId':'MY_F0042'});self.assertIsNotNone(relay.FAST)
            self.assertGreater(relay.FAST_DUE,0)
            relay.execute({'action':'slideshow','minutes':0,'shuffle':True});self.assertIsNone(relay.FAST)
            relay.execute({'action':'fast_slideshow','seconds':60,'shuffle':False})
            relay.execute({'action':'slideshow','minutes':30,'shuffle':False})
            self.assertIsNone(relay.FAST);self.assertEqual(tv.rotation,'30')
    def test_shuffle_visits_every_photo_before_repeating(self):
        tv=FakeTV();tv.ids={f'MY_F{i:04d}' for i in range(1,9)};tv.current='MY_F0001'
        relay.FAST={'seconds':30,'shuffle':True}
        visited=[tv.current]
        with patch.object(relay,'tv',return_value=tv):
            for _ in range(7):
                relay.FAST_DUE=0;relay.fast_tick();visited.append(tv.current)
            self.assertEqual(set(visited),tv.ids)
            self.assertEqual(len(set(visited)),8)
            previous=tv.current
            relay.FAST_DUE=0;relay.fast_tick()
            self.assertNotEqual(tv.current,previous)

    def test_shuffle_keeps_distance_across_cycles(self):
        tv=FakeTV();tv.ids={f'MY_F{i:04d}' for i in range(1,54)};tv.current='MY_F0001'
        relay.FAST={'seconds':30,'shuffle':True}
        visited=[tv.current]
        with patch.object(relay,'tv',return_value=tv):
            for _ in range(160):
                relay.FAST_DUE=0;relay.fast_tick()
                self.assertNotIn(tv.current,visited[-26:])
                visited.append(tv.current)
        for start in range(0,159,53):
            self.assertEqual(len(set(visited[start:start+53])),53)

    def test_failed_selection_remains_in_shuffle_cycle(self):
        tv=FakeTV();relay.FAST={'seconds':30,'shuffle':True}
        with patch.object(relay,'tv',return_value=tv),patch.object(tv,'select_image'):
            with self.assertRaises(RuntimeError):relay.fast_tick()
        self.assertNotIn('seen',relay.FAST)

    def test_fast_does_not_stop_already_stopped_native_rotation(self):
        tv=FakeTV();tv.rotation='off'
        with patch.object(relay,'tv',return_value=tv),patch.object(relay,'request'),patch.object(relay,'mapping',return_value={}),patch.object(tv,'set_auto_rotation_status') as stop:
            relay.execute({'action':'fast_slideshow','seconds':60,'shuffle':True})
            stop.assert_not_called()
        self.assertIsNotNone(relay.FAST)

    def test_fast_leaves_normal_tv_alone(self):
        tv=FakeTV();tv.artmode='off';relay.FAST={'seconds':30,'shuffle':True}
        with patch.object(relay,'tv',return_value=tv):relay.fast_tick()
        self.assertEqual(tv.current,'MY_F0042')
    def test_fast_resumes_after_art_mode_and_network_return(self):
        tv=FakeTV();tv.ids={f'MY_F{i:04d}' for i in range(1,7)};tv.current='MY_F0001'
        relay.FAST={'seconds':60,'shuffle':True}
        with patch.object(relay,'tv',return_value=tv):
            relay.fast_tick()
            remembered=dict(relay.FAST);current=tv.current
            tv.artmode='off';relay.FAST_DUE=0;relay.fast_tick()
            self.assertEqual(tv.current,current);self.assertEqual(relay.FAST,remembered)
            with patch.object(relay,'tv',side_effect=OSError('offline')):
                relay.FAST_DUE=0
                with self.assertRaises(OSError):relay.fast_tick()
            self.assertEqual(relay.FAST,remembered)
            tv.artmode='on';relay.FAST_DUE=0;relay.fast_tick()
            self.assertNotEqual(tv.current,current)
            self.assertNotEqual(tv.current,'MY_F0001')

    def test_fast_requires_two_photos_and_valid_interval(self):
        tv=FakeTV();tv.ids={'MY_F0042'}
        with patch.object(relay,'tv',return_value=tv):
            for seconds in [30,1]:
                with self.assertRaises(ValueError):relay.execute({'action':'fast_slideshow','seconds':seconds,'shuffle':True})
        self.assertIsNone(relay.FAST)

    def test_inline_thumbnail_protocol(self):
        payload={'id':'test','event':'thumbnail','content_id':'MY_F0042'}
        header=json.dumps({'event':'d2d_service_message','data':json.dumps(payload)}).encode()
        png=b'\x89PNG\r\n\x1a\nimage'
        frame=len(header).to_bytes(2,'big')+header+b'\n'+png
        art=Mock();art.get_uuid.return_value='test';art.connection.recv.return_value=frame
        self.assertEqual(relay.tv_thumbnail(art,'MY_F0042'),png)
    def test_preview_path_rejects_traversal(self):
        with self.assertRaises(ValueError):relay.preview_path('../../x')
    def test_rejects_untrusted_source(self):
        for url in ['http://stan-bouchet.eu/a','https://127.0.0.1/a','https://stan-bouchet.eu@evil.com/a']:
            with self.assertRaises(ValueError):relay.check_url(url)
    def test_duplicate_does_not_upload(self):
        with patch.object(relay,'tv',return_value=FakeTV()),patch.object(relay,'mapping',return_value={'photo':{'contentId':'MY_F0042'}}),patch.object(relay,'request'),patch.object(relay,'upload') as upload:
            result=relay.execute({'action':'upload','photos':[{'slug':'photo'}]})
            upload.assert_not_called();self.assertIn('1 déjà présente',result)
    def test_delete_only_existing_personal_photo(self):
        tv=FakeTV()
        with patch.object(relay,'tv',return_value=tv),patch.object(relay,'mapping',return_value={}),patch.object(relay,'save_map') as saved,patch.object(relay,'request'):
            result=relay.execute({'action':'delete','contentId':'MY_F0042'})
            self.assertEqual(tv.deleted,['MY_F0042']);saved.assert_called_once_with({});self.assertIn('Galerie conservée',result)
    def test_missing_photo_not_deleted(self):
        tv=FakeTV()
        with patch.object(relay,'tv',return_value=tv):
            with self.assertRaises(RuntimeError):relay.execute({'action':'delete','contentId':'SAM-S123'})
        self.assertEqual(tv.deleted,[])
if __name__=='__main__':unittest.main()
