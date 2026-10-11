#!/usr/bin/env python3
"""Relais local pour la Frame 2019 (Art API 0.97). Aucune écoute réseau entrante."""
import json
import os
from pathlib import Path
import signal
import subprocess
import threading
import time
import urllib.request
import urllib.parse
import uuid
from samsungtvws.art import SamsungTVArt

ROOT=Path(__file__).resolve().parent.parent
DATA=ROOT/'.processed/frame'
CONFIG=DATA/'relay.json'
ALLOWED={'stan-bouchet.eu','photos.bost7423.odns.fr'}
os.umask(0o077)
DATA.mkdir(parents=True,exist_ok=True)
config={}
ENDPOINT='https://admin.stan-bouchet.fr/api/frame-relay'
STOP=threading.Event()
class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):
        check_url(newurl)
        return super().redirect_request(req,fp,code,msg,headers,newurl)
def check_url(url):
    p=urllib.parse.urlparse(url)
    if p.scheme!='https' or p.hostname not in ALLOWED or p.port or p.username or p.password:
        raise ValueError('Source photo non autorisée')
def request(payload=None):
    data=json.dumps(payload).encode() if payload is not None else None
    req=urllib.request.Request(ENDPOINT,data=data,headers={'Authorization':'Bearer '+config['key'],'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=12) as response:return json.load(response)
def heartbeat():
    while not STOP.wait(5):
        try:request({})
        except Exception:pass

def mapping():
    try:return json.loads((DATA/'photos.json').read_text())
    except FileNotFoundError:return {}
def save_map(data):
    temp=DATA/'photos.tmp'
    temp.write_text(json.dumps(data));temp.replace(DATA/'photos.json')
def tv():
    return SamsungTVArt(config['host'],port=8001,timeout=8,token_file=str(DATA/'token.txt'),name='Galerie Stan')
def snapshot(art):
    items=art.available('MY-C0002')
    known={v['contentId']:{'slug':k,'title':v.get('title',k)} for k,v in mapping().items()}
    photos=[{'contentId':p['content_id'],**known.get(p['content_id'],{})} for p in items]
    rotation=art.get_auto_rotation_status()
    value=rotation.get('value','off')
    return {'photos':photos,'storage':None,'slideshow':{'minutes':0 if value=='off' else int(value),'category':rotation.get('category_id','')}}
def upload(art,photo):
    check_url(photo['url'])
    with urllib.request.build_opener(SafeRedirect()).open(photo['url'],timeout=15) as response:
        raw=response.read(25*1024*1024+1)
    if len(raw)>25*1024*1024:raise ValueError('Photo trop volumineuse')
    # sharp existant : préserver le cadrage entier et ajouter des marges si nécessaire.
    js="import sharp from 'sharp';let chunks=[];for await(const c of process.stdin)chunks.push(c);process.stdout.write(await sharp(Buffer.concat(chunks),{limitInputPixels:100000000}).rotate().resize(3840,2160,{fit:'contain',background:'#171717'}).jpeg({quality:90}).toBuffer());"
    data=subprocess.run(['node','--input-type=module','-e',js],input=raw,stdout=subprocess.PIPE,stderr=subprocess.PIPE,cwd=ROOT,timeout=25,check=True).stdout
    uid=str(uuid.uuid4())
    inner=json.dumps({'request':'send_image','file_type':'JPEG','matte_id':'none','id':uid},separators=(',',':'))
    header=json.dumps({'method':'ms.channel.emit','params':{'data':inner,'to':'host','event':'art_app_request'}},separators=(',',':')).encode()
    art.connection.send_binary(len(header).to_bytes(2,'big')+header+data)
    result=art.wait_for_response('image_added',uid)
    cid=result.get('content_id')
    if not cid:raise RuntimeError('Ajout non confirmé')
    data=mapping();data[photo['slug']]={'contentId':cid,'title':photo['title']};save_map(data)
    return cid

def execute(command):
    art=tv()
    try:
        signal.alarm(35)
        if art.get_api_version()!='0.97':raise RuntimeError('Version Art non validée pour ce relais')
        action=command['action']
        message='Inventaire TV actualisé.'
        if action=='upload':
            present={p['content_id'] for p in art.available('MY-C0002')}
            added=skipped=0
            for photo in command['photos']:
                signal.alarm(90)
                old=mapping().get(photo['slug'])
                if old and old['contentId'] in present:skipped+=1;continue
                cid=upload(art,photo);present.add(cid);added+=1
            message=f'{added} photo(s) ajoutée(s), {skipped} déjà présente(s).'
        elif action in ('show','delete'):
            cid=command['contentId']
            if cid not in {p['content_id'] for p in art.available('MY-C0002')}:raise RuntimeError('Photo absente de la TV')
            if action=='show':
                art.select_image(cid,show=True)
                if art.get_current().get('content_id')!=cid:raise RuntimeError('Affichage non confirmé')
                message='Photo affichée sur la TV.'
            else:
                if not art.delete(cid):raise RuntimeError('Suppression non confirmée')
                if cid in {p['content_id'] for p in art.available('MY-C0002')}:raise RuntimeError('Photo toujours présente sur la TV')
                save_map({k:v for k,v in mapping().items() if v['contentId']!=cid})
                message='Copie supprimée de la TV. Galerie conservée.'
        elif action=='slideshow':
            art.set_auto_rotation_status(duration=command['minutes'],type=command['shuffle'],category=2)
            rotation=art.get_auto_rotation_status()
            expected=str(command['minutes']) if command['minutes'] else 'off'
            if rotation.get('value')!=expected or (command['minutes'] and rotation.get('category_id')!='MY-C0002'):raise RuntimeError('Réglage du diaporama non confirmé')
            message=f"Diaporama : {command['minutes']} minutes par photo." if command['minutes'] else 'Diaporama arrêté.'
        signal.alarm(30)
        request({'snapshot':snapshot(art)})
        return message
    finally:
        signal.alarm(0);art.close()

def expired(*_):raise TimeoutError('La TV ne répond pas. Vérifie le mode Art.')
def main():
    config.update(json.loads(CONFIG.read_text()))
    signal.signal(signal.SIGALRM,expired)
    # Un seul relais par Mac : évite de concurrencer le canal Art.
    import fcntl
    lock=(DATA/'relay.lock').open('w')
    try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:raise SystemExit('Le relais est déjà ouvert.')
    threading.Thread(target=heartbeat,daemon=True).start()
    print('Relais Galerie Stan ouvert. Garde cette fenêtre ouverte pendant les commandes.',flush=True)
    last_sync=0
    try:
        while True:
            try:
                job=request().get('job')
                if job:
                    try:
                        message=execute(job['command']);ok=True
                    except Exception as e:
                        ok=False
                        message=('La TV ne répond pas. Vérifie le mode Art et le réseau. Vérifie son contenu avant de réessayer un envoi.' if isinstance(e,(TimeoutError,OSError)) or 'Timeout' in type(e).__name__ else 'Commande non confirmée par la TV. Actualise son contenu avant de réessayer.')
                    result={'result':{'id':job['id'],'ok':ok,'message':message}}
                    # Le rapport est idempotent ; la commande TV n'est jamais rejouée.
                    while True:
                        try:request(result);break
                        except Exception:time.sleep(5)
                    print(message,flush=True);last_sync=time.monotonic()
                elif time.monotonic()-last_sync>60:
                    try:execute({'action':'refresh'})
                    except Exception:print('Inventaire indisponible : vérifie le mode Art.',flush=True)
                    last_sync=time.monotonic()
            except KeyboardInterrupt:raise
            except Exception:print('Connexion à l’admin indisponible, nouvel essai prochainement.',flush=True)
            time.sleep(3)
    except KeyboardInterrupt:print('Relais arrêté.',flush=True)
    finally:STOP.set()
if __name__=='__main__':main()
