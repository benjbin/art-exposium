<?php
/* Neokrome — réception d'une demande envoyée par un formulaire du site.
   POST JSON { source, langue, nom, prenom, entreprise, email, telephone, projet, message, ...détails } */
declare(strict_types=1);
require __DIR__ . '/_db.php';

/* sites autorisés à envoyer (le site lui-même, sa version GitHub Pages, le test local) */
$origines = ['https://neokrome.tech', 'https://www.neokrome.tech', 'https://benjbin.github.io'];
$origine = $_SERVER['HTTP_ORIGIN'] ?? '';
$local = (bool) preg_match('#^http://(localhost|127\.0\.0\.1)(:\d+)?$#', $origine);
if ($origine && (in_array($origine, $origines, true) || $local)) {
    header('Access-Control-Allow-Origin: ' . $origine);
    header('Vary: Origin');
    header('Access-Control-Allow-Methods: POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
    header('Access-Control-Max-Age: 86400');
}
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') { http_response_code(204); exit; }
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') nk_json(['ok' => false, 'erreur' => 'methode'], 405);
if ($origine && !in_array($origine, $origines, true) && !$local) nk_json(['ok' => false, 'erreur' => 'origine'], 403);

$brut = file_get_contents('php://input', false, null, 0, 40000) ?: '';
$d = json_decode($brut, true);
if (!is_array($d)) nk_json(['ok' => false, 'erreur' => 'format'], 400);

/* robot : champ piège rempli → on répond « ok » sans rien enregistrer */
if (!empty($d['_honey'])) nk_json(['ok' => true]);

$txt = fn(string $k, int $max = 200) => mb_substr(trim(preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', '', (string) ($d[$k] ?? ''))), 0, $max);
$source = $txt('source', 30);
if (!isset(NK_SOURCES[$source])) $source = 'contact';
$email = $txt('email', 200);
if (!filter_var($email, FILTER_VALIDATE_EMAIL)) nk_json(['ok' => false, 'erreur' => 'email'], 422);

$connus = ['source', 'langue', 'nom', 'prenom', 'entreprise', 'email', 'telephone', 'projet', 'message'];
$details = [];
foreach ($d as $k => $v) {
    if (in_array($k, $connus, true) || str_starts_with((string) $k, '_') || !is_scalar($v)) continue;
    if (count($details) >= 20) break;
    $v = mb_substr(trim((string) $v), 0, 300);
    if ($v !== '') $details[mb_substr((string) $k, 0, 40)] = $v;
}

$db = nk_db();
$ip = nk_ip_hash();
/* limite : 8 demandes par heure et par visiteur */
$s = $db->prepare("SELECT COUNT(*) FROM demandes WHERE ip_hash = ? AND recue_le > strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 hour')");
$s->execute([$ip]);
if ((int) $s->fetchColumn() >= 8) nk_json(['ok' => false, 'erreur' => 'limite'], 429);

$db->prepare('INSERT INTO demandes (source, langue, nom, prenom, entreprise, email, telephone, projet, message, details, ip_hash, agent)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
   ->execute([
       $source, $txt('langue', 5) === 'en' ? 'en' : 'fr',
       $txt('nom', 120), $txt('prenom', 120), $txt('entreprise', 160), $email,
       $txt('telephone', 40), $txt('projet', 120), $txt('message', 4000),
       json_encode($details ?: new stdClass, JSON_UNESCAPED_UNICODE), $ip,
       mb_substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 250),
   ]);
nk_json(['ok' => true, 'id' => (int) $db->lastInsertId()], 201);
