import test from 'node:test';
import assert from 'node:assert/strict';
import { publicPagePath, publicPagePaths } from '../../src/pwa/publicPageRoutes.ts';

const base = 'https://pwa-titanium.vercel.app';
const route = (path) => publicPagePath(new URL(path, base));

test('el App Shell contiene únicamente las nueve rutas públicas esperadas', () => {
  assert.deepEqual([...publicPagePaths], [
    '/', '/catalogue', '/suscripciones', '/about', '/terms',
    '/aviso-privacidad', '/login', '/register', '/forgot-password',
  ]);
});

test('cada ruta pública está admitida para navegación offline', () => {
  for (const path of publicPagePaths) assert.equal(route(path), path, path);
});

test('se permiten las rutas de detalle de productos públicos', () => {
  assert.equal(route('/catalogue/41'), '/catalogue/41');
  assert.equal(route('/catalogue/abc-123'), '/catalogue/abc-123');
});

test('se mantienen los alias históricos de Acerca de', () => {
  assert.equal(route('/AboutPage'), '/AboutPage');
  assert.equal(route('/AboutePage'), '/AboutePage');
});

test('las consultas no forman parte de la identidad de la ruta', () => {
  assert.equal(route('/about?ref=pwa'), '/about');
  assert.equal(route('/catalogue/41?campaign=test'), '/catalogue/41');
  assert.equal(route('/?installed=true'), '/');
});

test('las barras finales se normalizan', () => {
  assert.equal(route('/about/'), '/about');
  assert.equal(route('/catalogue/'), '/catalogue');
  assert.equal(route('/'), '/');
});

test('no se incluyen respuestas de API en el App Shell', () => {
  for (const path of ['/api', '/api/products', '/api/memberships/plans', '/api/auth/login']) {
    assert.equal(route(path), undefined, path);
  }
});

test('las rutas privadas y de pago quedan excluidas', () => {
  for (const path of ['/admin', '/cliente', '/trainer', '/payment', '/checkout', '/profile', '/orders']) {
    assert.equal(route(path), undefined, path);
  }
});

test('no se admiten rutas desconocidas o anidamientos privados', () => {
  for (const path of ['/does-not-exist', '/about/private', '/catalogue/41/edit', '/catalogue/../../admin']) {
    assert.equal(route(path), undefined, path);
  }
});
