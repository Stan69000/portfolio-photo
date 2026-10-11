import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const hasPhp = spawnSync('php', ['-v']).status === 0;

test('public relay serves only authorized published versions and fails closed', { skip: !hasPhp }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kdrive-relay-'));
  try {
    await fs.copyFile(new URL('../public/media-kdrive.php', import.meta.url), path.join(dir, 'media-kdrive.php'));
    await fs.writeFile(path.join(dir, 'kdrive-media.json'), JSON.stringify({ 'photo-001': { drive_id: '620855', files: { thumb: '1', web: '2', zoom: '3' } } }));
    const privatePath = path.join(dir, 'private.php');
    await fs.writeFile(privatePath, '<?php return ["token"=>"private-test-token","drive_id"=>"620855"];');
    const run = (params, { method = 'GET', configured = true, upstreamStatus = 200, bytes = 'RIFF0000WEBPexample' } = {}) => {
      // php -n lets these fake cURL functions test the relay without any network access.
      const code = `
        foreach(['CURLOPT_HTTPHEADER','CURLOPT_RETURNTRANSFER','CURLOPT_FOLLOWLOCATION','CURLOPT_UNRESTRICTED_AUTH','CURLOPT_MAXREDIRS','CURLOPT_REDIR_PROTOCOLS','CURLOPT_CONNECTTIMEOUT','CURLOPT_TIMEOUT','CURLOPT_PROTOCOLS','CURLPROTO_HTTPS','CURLINFO_HTTP_CODE'] as $i=>$name)if(!defined($name))define($name,$i+1);
        function curl_init($url){return $url;}
        function curl_setopt_array($handle,$options){}
        function curl_exec($handle){return base64_decode('${Buffer.from(bytes).toString('base64')}');}
        function curl_getinfo($handle,$option){return ${upstreamStatus};}
        function curl_close($handle){}
        $_SERVER['REQUEST_METHOD']='${method}';
        $_GET=json_decode(base64_decode('${Buffer.from(JSON.stringify(params)).toString('base64')}'),true);
        register_shutdown_function(function(){fwrite(STDERR,(string)(http_response_code()?:200));});
        require '${path.join(dir, 'media-kdrive.php')}';`;
      return spawnSync('php', ['-n', '-d', 'disable_functions=curl_init,curl_setopt_array,curl_exec,curl_getinfo,curl_close', '-r', code], {
        encoding: 'utf8', env: { ...process.env, KDRIVE_TOKEN: '', KDRIVE_ID: '', KDRIVE_CONFIG_PATH: configured ? privatePath : path.join(dir, 'missing.php') },
      });
    };
    for (const [params, options, status] of [
      [{ slug: 'draft', version: 'web' }, {}, '404'],
      [{ slug: '../private', version: 'web' }, {}, '404'],
      [{ slug: 'photo-001', version: 'original' }, {}, '404'],
      [{ slug: ['photo-001'], version: 'web' }, {}, '404'],
      [{ slug: 'photo-001', version: 'web' }, { method: 'POST' }, '405'],
      [{ slug: 'photo-001', version: 'web' }, { configured: false }, '503'],
      [{ slug: 'photo-001', version: 'web' }, { upstreamStatus: 403 }, '502'],
      [{ slug: 'photo-001', version: 'web' }, { bytes: '{"token":"private-test-token"}' }, '502'],
    ]) {
      const result = run(params, options);
      assert.equal(result.stderr.trim(), status, result.stdout + result.stderr);
      assert.equal(result.stdout, '');
    }
    const image = run({ slug: 'photo-001', version: 'web' });
    assert.equal(image.stderr, '200');
    assert.equal(image.stdout, 'RIFF0000WEBPexample');
    const head = run({ slug: 'photo-001', version: 'web' }, { method: 'HEAD' });
    assert.equal(head.stderr, '200');
    assert.equal(head.stdout, '');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
