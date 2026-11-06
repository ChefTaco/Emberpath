import { describe, expect, it } from 'vitest';
import { createAdminApp } from '../../src/admin/app.js';

describe('admin fallback page', () => {
  it('names Emberpath, describes the admin API and points to HiveXUI as the suite console', async () => {
    const response = await createAdminApp().request('/');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/text\/html/u);
    const page = await response.text();
    expect(page).toContain('<title>Emberpath</title>');
    expect(page).toMatch(/Emberpath admin API/u);
    expect(page).toMatch(/HiveXUI/u);
    expect(page).not.toMatch(/Hive Router|build:ui/u);
  });

  it('never serves the page for API paths', async () => {
    const response = await createAdminApp().request('/api/not-a-route');
    expect(response.status).not.toBe(200);
    expect(await response.text()).not.toContain('<title>Emberpath</title>');
  });
});
