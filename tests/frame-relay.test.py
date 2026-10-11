import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('relay',Path(__file__).resolve().parents[1]/'scripts/frame-relay.py')
relay=importlib.util.module_from_spec(spec);spec.loader.exec_module(relay)
class FakeTV:
    def __init__(self):self.ids={'MY_F0042'};self.deleted=[]
    def get_api_version(self):return '0.97'
    def available(self,*a):return [{'content_id':i} for i in self.ids]
    def delete(self,cid):self.deleted.append(cid);self.ids.remove(cid);return True
    def get_auto_rotation_status(self):return {'value':'10','category_id':'MY-C0002'}
    def close(self):pass
class RelayTests(unittest.TestCase):
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
