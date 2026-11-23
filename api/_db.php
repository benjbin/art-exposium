<?php
/* Neokrome — base SQLite des demandes reçues (partagée par l'API et l'admin) */
declare(strict_types=1);

const NK_DB = __DIR__ . '/../data/neokrome.sqlite';
const NK_SOURCES = ['attente' => 'Page d’attente', 'contact' => 'Contact', 'demo' => 'Démo', 'rendez-vous' => 'Rendez-vous'];
const NK_STATUTS = ['nouveau' => 'Nouvelle', 'en_cours' => 'En cours', 'traite' => 'Traitée', 'archive' => 'Archivée'];

function nk_db(): PDO {
    static $db = null;
    if ($db) return $db;
    $db = new PDO('sqlite:' . NK_DB, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    $db->exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 4000;');
    $db->exec("CREATE TABLE IF NOT EXISTS demandes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        recue_le    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        source      TEXT NOT NULL,
        langue      TEXT NOT NULL DEFAULT 'fr',
        nom         TEXT NOT NULL DEFAULT '',
        prenom      TEXT NOT NULL DEFAULT '',
        entreprise  TEXT NOT NULL DEFAULT '',
        email       TEXT NOT NULL,
        telephone   TEXT NOT NULL DEFAULT '',
        projet      TEXT NOT NULL DEFAULT '',
        message     TEXT NOT NULL DEFAULT '',
        details     TEXT NOT NULL DEFAULT '{}',
        statut      TEXT NOT NULL DEFAULT 'nouveau',
        note        TEXT NOT NULL DEFAULT '',
        maj_le      TEXT,
        ip_hash     TEXT NOT NULL DEFAULT '',
        agent       TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS demandes_recue ON demandes(recue_le);
    CREATE INDEX IF NOT EXISTS demandes_statut ON demandes(statut);
    CREATE TABLE IF NOT EXISTS reglages (cle TEXT PRIMARY KEY, valeur TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS echecs (ip_hash TEXT NOT NULL, le INTEGER NOT NULL);");
    return $db;
}

function nk_get(string $k): ?string {
    $s = nk_db()->prepare('SELECT valeur FROM reglages WHERE cle = ?');
    $s->execute([$k]);
    $v = $s->fetchColumn();
    return $v === false ? null : (string) $v;
}
function nk_set(string $k, string $v): void {
    nk_db()->prepare('INSERT INTO reglages(cle, valeur) VALUES(?, ?) ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur')->execute([$k, $v]);
}

/* empreinte de l'IP (jamais stockée en clair), salée par une clé propre à l'installation */
function nk_ip_hash(): string {
    $sel = nk_get('sel');
    if (!$sel) { $sel = bin2hex(random_bytes(16)); nk_set('sel', $sel); }
    return substr(hash('sha256', $sel . ($_SERVER['REMOTE_ADDR'] ?? '')), 0, 24);
}

function nk_json($data, int $code = 200): never {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}
