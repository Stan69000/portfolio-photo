import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {emotions, matchesEmotion} from '../src/lib/discovery.js';
const source = fs.readFileSync(new URL('../admin-server.js',import.meta.url),'utf8');
function extract(name) {
  const start=source.indexOf(`function ${name}(`);
  if (name === 'esc') return source.slice(start, source.indexOf('\n',start));
  if (name === 'tagInputWidget') return source.slice(start, source.indexOf('// ─── LAYOUT',start));
  return source.slice(start,source.indexOf('\n}',start)+2);
}
function renderWidget(tags=[]) {
  const context = vm.createContext({readTagCollections:()=>emotions,catColor:()=> '#748fff'});
  vm.runInContext(['esc','normalizeTags','parseTag','tagInputWidget'].map(extract).join('\n'),context);
  return vm.runInContext(`tagInputWidget('tags', ${JSON.stringify(tags)}, [], 'example')`,context);
}
test('collection keywords are shared with public discovery and offered even before use',()=>{
  const html=renderWidget();
  for(const emotion of emotions) {
    assert.ok(html.includes(`data-collection="${emotion.slug}"`));
    for(const tag of emotion.tags) {
      assert.ok(html.includes(`data-collection-tag="${tag}"`));
      assert.equal(matchesEmotion({data:{tags:[tag],emotions:[]}},emotion),true);
    }
  }
});
test('collection clicks update the tags and associated emotion without submitting the form',()=>{
  const html=renderWidget();
  const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const buttons=emotions.flatMap(e=>e.tags.map(tag=>({dataset:{collectionTag:tag,collection:e.slug}, addEventListener(type,cb){this.click=cb;}})));
  const emotion={value:''};
  const form={querySelectorAll:()=>buttons,querySelector:()=>emotion};
  const hidden={value:'',closest:()=>form};
  const elements={'example-hidden':hidden,'example-input':{value:'',addEventListener(){}},'example-catsel':{value:'Lieu'},'example-chips':{innerHTML:''}};
  vm.runInNewContext(script,{document:{getElementById:id=>elements[id]},window:{}});
  const button=buttons.find(b=>b.dataset.collectionTag==='nature');
  button.click(); button.click();
  assert.equal(hidden.value,'nature');
  assert.equal(emotion.value,'ralentir');
});
test('tag text remains text in the widget and cannot close its script',()=>{
  const html=renderWidget(['<img src=x>','</script>']);
  assert.equal((html.match(/<\/script>/g)||[]).length,1);
  const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const chips={innerHTML:''};
  const elements={'example-hidden':{closest:()=>({querySelectorAll:()=>[]})},'example-input':{value:'',addEventListener(){}},'example-catsel':null,'example-chips':chips};
  vm.runInNewContext(script,{document:{getElementById:id=>elements[id]},window:{}});
  assert.ok(chips.innerHTML.includes('&lt;img src=x&gt;'));
  assert.ok(!chips.innerHTML.includes('<img'));
});
