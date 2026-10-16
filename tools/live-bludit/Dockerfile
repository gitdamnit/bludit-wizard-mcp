# A throwaway Bludit installation, for live integration testing.
#
# PHP 8.3 with Apache, because Bludit's installer checks for mod_rewrite and for
# a writable `bl-content` directory. The rewrite rules in Bludit's own
# `.htaccess` are what route `/api/*` to `index.php`, so `AllowOverride All` is
# required — without it every API request 404s.
#
# Not hardened, not for production, never exposed. It exists so the MCP server's
# compatibility claims can be checked against a real CMS rather than a mock.
FROM php:8.3-apache

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libonig-dev libpng-dev libjpeg62-turbo-dev libfreetype6-dev \
 && docker-php-ext-configure gd --with-freetype --with-jpeg \
 && docker-php-ext-install mbstring gd \
 && a2enmod rewrite \
 && sed -ri 's/AllowOverride None/AllowOverride All/g' /etc/apache2/apache2.conf \
 && printf 'ServerName localhost\n' > /etc/apache2/conf-available/servername.conf \
 && a2enconf servername \
 && rm -rf /var/lib/apt/lists/*

# Errors go to the container log, never into an HTTP response.
RUN printf 'display_errors=Off\nlog_errors=On\nerror_reporting=E_ALL\n' \
      > /usr/local/etc/php/conf.d/zz-bludit.ini

# The Bludit tree is staged beside this Dockerfile by
# scripts/live-bludit-up.sh, which passes SITE_DIR=site-community or
# SITE_DIR=site-pro.
ARG SITE_DIR=site-community
COPY ${SITE_DIR}/ /var/www/html/

RUN chown -R www-data:www-data /var/www/html

EXPOSE 80
