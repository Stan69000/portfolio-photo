<?php
// Stateless relay: photos stay on kDrive. Credentials must be outside the web root.
declare(strict_types=1);
ini_set('display_errors', '0');
header('X-Content-Type-Options: nosniff');
function stop(int $status): never {
    http_response_code($status);
    header('Cache-Control: no-store');
    exit;
}
if (!in_array($_SERVER['REQUEST_METHOD'] ?? '', ['GET', 'HEAD'], true)) stop(405);
$slug = $_GET['slug'] ?? '';
$version = $_GET['version'] ?? 'web';
if (!is_string($slug) || !preg_match('/^[a-z0-9][a-z0-9-]{0,240}$/D', $slug)) stop(404);
if (!is_string($version) || !in_array($version, ['thumb', 'web', 'zoom'], true)) stop(404);
$manifest = json_decode(@file_get_contents(__DIR__ . '/kdrive-media.json') ?: '{}', true);
$item = $manifest[$slug] ?? null;
if (!$item) stop(404);
$config = [];
$configPath = getenv('KDRIVE_CONFIG_PATH') ?: dirname(__DIR__) . '/kdrive-config.php';
try {
    if (is_file($configPath)) $config = require $configPath;
} catch (Throwable $error) { stop(503); }
$token = getenv('KDRIVE_TOKEN') ?: ($config['token'] ?? '');
$drive = getenv('KDRIVE_ID') ?: ($config['drive_id'] ?? '');
$id = $item['files'][$version] ?? '';
if (!$token || !preg_match('/^\d+$/D', (string)$drive) || (string)$item['drive_id'] !== (string)$drive) stop(503);
if (!preg_match('/^\d+$/D', (string)$id)) stop(404);
if (!function_exists('curl_init')) stop(503);
$curl = curl_init('https://api.infomaniak.com/2/drive/' . $drive . '/files/' . $id . '/download');
curl_setopt_array($curl, [
    CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $token],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_UNRESTRICTED_AUTH => false,
    CURLOPT_MAXREDIRS => 3,
    CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTPS,
    CURLOPT_CONNECTTIMEOUT => 10,
    CURLOPT_TIMEOUT => 60,
    CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
]);
$image = curl_exec($curl);
$status = curl_getinfo($curl, CURLINFO_HTTP_CODE);
curl_close($curl);
// Fail closed on errors and non-WebP responses, without exposing upstream details.
if ($status !== 200 || !is_string($image) || substr($image, 0, 4) !== 'RIFF' || substr($image, 8, 4) !== 'WEBP') stop(502);
header('Content-Type: image/webp');
header('Content-Length: ' . strlen($image));
header('Cache-Control: public, max-age=300');
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'HEAD') echo $image;
