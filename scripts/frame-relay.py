#!/usr/bin/env python3
"""Relais local pour la Frame 2019 (Art API 0.97). Aucune écoute réseau entrante."""
import json
import base64
import re
import os
import random
from pathlib import Path
import signal
import subprocess
import threading
import time
import urllib.request
import urllib.parse
import uuid
from samsungtvws.art import SamsungTVArt, ArtChannelEmitCommand

ROOT=Path(__file__).resolve().parent.parent
DATA=ROOT/'.processed/frame'
CONFIG=DATA/'relay.json'
ALLOWED={'stan-bouchet.eu','photos.bost7423.odns.fr'}
os.umask(0o077)
DATA.mkdir(parents=True,exist_ok=True)
config={}
ENDPOINT='https://admin.stan-bouchet.fr/api/frame-relay'
STOP=threading.Event()
FAST=None
FAST_DUE=0
PREVIEW_IDS=[]
PREVIEW_RETRY={}
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
def preview_path(cid):
    if not re.fullmatch(r'MY_F[0-9]{1,8}',cid):raise ValueError('Identifiant photo invalide')
    return DATA/'previews'/f'{cid}.jpg'
def cached_preview(cid):
    path=preview_path(cid)
    if not path.exists():return None
    return 'data:image/jpeg;base64,'+base64.b64encode(path.read_bytes()).decode()
def tv_thumbnail(art,cid):
    # API 0.97: miniature jointe à une trame WebSocket binaire,
    # précédée de la longueur JSON sur deux octets (pas de socket D2D).
    if not art.connection:art.open()
    uid=art.get_uuid()
    art.send_command(ArtChannelEmitCommand.art_app_request({'request':'get_thumbnail','content_id':cid,'id':uid,'request_id':uid}))
    while True:
        raw=art.connection.recv()
        binary=None
        if isinstance(raw,bytes):
            size=int.from_bytes(raw[:2],'big')
            if size<2 or size>len(raw)-2:raise ValueError('Entête de miniature invalide')
            frame=json.loads(raw[2:2+size])
            binary=raw[2+size:].lstrip(b'\r\n')
        else:frame=json.loads(raw)
        if frame.get('event')!='d2d_service_message':continue
        payload=json.loads(frame['data'])
        if payload.get('request_id',payload.get('id'))!=uid:continue
        if payload.get('event')=='error':raise RuntimeError('Miniature refusée par la TV')
        if payload.get('event')=='thumbnail' and payload.get('content_id')==cid and binary:
            if len(binary)>5*1024*1024:raise ValueError('Miniature TV trop volumineuse')
            return binary

def cache_preview(art,cid):
    path=preview_path(cid)
    if path.exists():return
    raw=tv_thumbnail(art,cid)
    js="import sharp from 'sharp';let chunks=[];for await(const c of process.stdin)chunks.push(c);process.stdout.write(await sharp(Buffer.concat(chunks),{limitInputPixels:20000000}).resize(240,135,{fit:'inside',withoutEnlargement:true}).jpeg({quality:65}).toBuffer());"
    data=subprocess.run(['node','--input-type=module','-e',js],input=bytes(raw),stdout=subprocess.PIPE,stderr=subprocess.PIPE,cwd=ROOT,timeout=10,check=True).stdout
    if len(data)>30000:raise ValueError('Aperçu trop volumineux')
    path.parent.mkdir(parents=True,exist_ok=True)
    temp=path.with_suffix('.tmp');temp.write_bytes(data);temp.replace(path)
def preview_tick():
    if FAST and FAST_DUE-time.monotonic()<20:return
    cid=next((i for i in PREVIEW_IDS if not preview_path(i).exists() and time.monotonic()>=PREVIEW_RETRY.get(i,0)),None)
    if not cid:return
    PREVIEW_RETRY[cid]=time.monotonic()+300
    art=tv()
    try:
        signal.alarm(20);cache_preview(art,cid)
    finally:signal.alarm(0);art.close()
def snapshot(art):
    global PREVIEW_IDS
    items=art.available('MY-C0002')
    known={v['contentId']:{'slug':k,'title':v.get('title',k)} for k,v in mapping().items()}
    photos=[{'contentId':p['content_id'],**known.get(p['content_id'],{})} for p in items]
    PREVIEW_IDS=[p['contentId'] for p in photos]
    for p in photos:
        preview=cached_preview(p['contentId'])
        if preview:p['preview']=preview
    rotation=art.get_auto_rotation_status()
    value=rotation.get('value','off')
    return {'photos':photos,'storage':None,'slideshow':{'minutes':0 if value=='off' else int(value),'category':rotation.get('category_id',''),'mode':'fast' if FAST else 'native','seconds':FAST['seconds'] if FAST else None}}
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

def restore_rotation(art, rotation):
    if rotation.get('value', 'off') != 'off':
        category=rotation.get('category_id', 'MY-C0002')
        art.set_auto_rotation_status(duration=int(rotation['value']),
            type=rotation.get('type', config.get('rotation_type', 'shuffleslideshow')) != 'slideshow',
            category=int(category[-1]))
        if art.get_auto_rotation_status().get('value') != rotation['value']:
            raise RuntimeError('Reprise du diaporama non confirmée')

def fast_tick():
    global FAST_DUE
    if not FAST or time.monotonic() < FAST_DUE:return
    # Pas de rattrapage en rafale après veille ou perte du réseau.
    FAST_DUE=time.monotonic()+FAST['seconds']
    art=tv()
    try:
        signal.alarm(25)
        if art.get_artmode() != 'on':return
        ids=[p['content_id'] for p in art.available('MY-C0002')]
        if len(ids)<2:return
        current=art.get_current().get('content_id')
        if FAST['shuffle']:
            seen=set(FAST.get('seen', [])) & set(ids)
            seen.add(current)
            remaining=[i for i in ids if i not in seen]
            if not remaining:
                seen=set()
                remaining=list(ids)
            # Garder aussi une distance entre les répétitions à la jonction des tours.
            recent=[i for i in FAST.get('recent', []) if i in ids]
            if not recent or recent[-1]!=current:recent.append(current)
            recent=recent[-max(1,len(ids)//2):]
            candidates=[i for i in remaining if i not in recent]
            cid=random.choice(candidates or remaining)
        else:cid=ids[(ids.index(current)+1)%len(ids)] if current in ids else ids[0]
        art.select_image(cid,show=True)
        if art.get_current().get('content_id')!=cid:raise RuntimeError('Affichage rapide non confirmé')
        if FAST['shuffle']:
            FAST['seen']=list(seen | {cid})
            FAST['recent']=(recent+[cid])[-max(1,len(ids)//2):]
        print(f'Photo TV affichée : {cid}',flush=True)
    finally:
        signal.alarm(0);art.close()

def execute(command):
    global FAST, FAST_DUE
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
                rotation=art.get_auto_rotation_status()
                art.select_image(cid,show=True)
                if art.get_current().get('content_id')!=cid:raise RuntimeError('Affichage non confirmé')
                if FAST:FAST_DUE=time.monotonic()+FAST['seconds']
                else:restore_rotation(art,rotation)
                message='Photo affichée sur la TV. Le diaporama en cours est conservé.'
            else:
                if not art.delete(cid):raise RuntimeError('Suppression non confirmée')
                if cid in {p['content_id'] for p in art.available('MY-C0002')}:raise RuntimeError('Photo toujours présente sur la TV')
                save_map({k:v for k,v in mapping().items() if v['contentId']!=cid})
                message='Copie supprimée de la TV. Galerie conservée.'
        elif action=='slideshow':
            if command.get('mode')=='fast' and command['minutes']!=0:
                raise ValueError('Utiliser la commande fast_slideshow')
            art.set_auto_rotation_status(duration=command['minutes'],type=command['shuffle'],category=2)
            rotation=art.get_auto_rotation_status()
            expected=str(command['minutes']) if command['minutes'] else 'off'
            if rotation.get('value')!=expected or (command['minutes'] and rotation.get('category_id')!='MY-C0002'):raise RuntimeError('Réglage du diaporama non confirmé')
            FAST=None
            config['rotation_type']='shuffleslideshow' if command['shuffle'] else 'slideshow'
            message=f"Diaporama : {command['minutes']} minutes par photo." if command['minutes'] else 'Diaporama arrêté.'
        elif action=='fast_slideshow':
            seconds=command['seconds']
            if seconds not in (30,60,300):raise ValueError('Durée rapide non autorisée')
            if len(art.available('MY-C0002'))<2:raise ValueError('Deux photos au minimum sont nécessaires')
            # Certaines Frame ne répondent pas à un arrêt déjà effectif.
            if art.get_auto_rotation_status().get('value')!='off':
                art.set_auto_rotation_status(duration=0,type=True,category=2)
                if art.get_auto_rotation_status().get('value')!='off':raise RuntimeError('Arrêt du diaporama natif non confirmé')
            FAST={'seconds':seconds,'shuffle':command['shuffle']}
            FAST_DUE=time.monotonic()+seconds
            message=f'Diaporama rapide : {seconds} secondes par photo. Garde le Mac éveillé et le relais ouvert.'
        elif action!='refresh':raise ValueError('Commande inconnue : mets à jour le relais')
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
            job=None
            try:
                job=request().get('job')
                if job:
                    try:
                        message=execute(job['command']);ok=True
                    except Exception as e:
                        ok=False
                        message=('La TV ne répond pas. Vérifie le mode Art et le réseau. Vérifie son contenu avant de réessayer un envoi.' if isinstance(e,(TimeoutError,OSError)) or 'Timeout' in type(e).__name__ else str(e) if isinstance(e,ValueError) else 'Commande non confirmée par la TV. Actualise son contenu avant de réessayer.')
                    result={'result':{'id':job['id'],'ok':ok,'message':message}}
                    # Le rapport est idempotent ; la commande TV n'est jamais rejouée.
                    while True:
                        try:request(result);break
                        except Exception:time.sleep(5)
                    print(message,flush=True);last_sync=time.monotonic()
                if not job and time.monotonic()-last_sync>60:
                    try:execute({'action':'refresh'})
                    except Exception:print('Inventaire indisponible : vérifie le mode Art.',flush=True)
                    last_sync=time.monotonic()
            except KeyboardInterrupt:raise
            except Exception:print('Connexion à l’admin indisponible, nouvel essai prochainement.',flush=True)
            try:fast_tick()
            except Exception:print('Changement rapide indisponible : vérifie le mode Art et le réseau.',flush=True)
            if not job:
                try:preview_tick()
                except Exception:print('Un aperçu TV est temporairement indisponible.',flush=True)
            time.sleep(3)
    except KeyboardInterrupt:print('Relais arrêté.',flush=True)
    finally:STOP.set()
if __name__=='__main__':main()
