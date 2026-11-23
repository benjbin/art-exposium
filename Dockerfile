# Neokrome — site statique + API / tableau de bord PHP (SQLite)
# Coolify : build pack « Dockerfile », port 80, volume persistant sur /var/www/html/data
FROM php:8.3-apache-bookworm

# pdo_sqlite est inclus dans l'image officielle ; on ajoute les réglages Apache/PHP
RUN a2enmod remoteip headers expires rewrite \
 && rm -f /etc/apache2/conf-enabled/security.conf \
 && mv "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini"
COPY docker/apache-neokrome.conf /etc/apache2/conf-enabled/zz-neokrome.conf
COPY docker/php-neokrome.ini "$PHP_INI_DIR/conf.d/zz-neokrome.ini"
COPY docker/entrypoint.sh /usr/local/bin/nk-entrypoint
RUN chmod +x /usr/local/bin/nk-entrypoint

WORKDIR /var/www/html
COPY --chown=www-data:www-data . .
RUN rm -rf docker Dockerfile .dockerignore \
 && mkdir -p data && chown www-data:www-data data

VOLUME ["/var/www/html/data"]
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD php -r 'exit(@file_get_contents("http://127.0.0.1/") === false ? 1 : 0);'
ENTRYPOINT ["nk-entrypoint"]
CMD ["apache2-foreground"]
