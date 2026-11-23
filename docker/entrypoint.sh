#!/bin/sh
# Le volume Coolify monté sur data/ doit appartenir à Apache pour que SQLite puisse écrire.
set -e
mkdir -p /var/www/html/data
chown -R www-data:www-data /var/www/html/data
chmod 750 /var/www/html/data
exec docker-php-entrypoint "$@"
