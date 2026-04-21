import { test, expect } from '@playwright/test';

/**
 * E2E tests for the Archive Upload feature in the RepoAnalyzer component.
 *
 * These tests cover:
 *   - Visibility and selection of the "Upload Archive" tab
 *   - Drop zone rendering with correct instructions
 *   - File selection via the hidden file input
 *   - Analyze button enabled/disabled state based on file selection
 *
 * All backend calls are mocked at the network level so no live server is required.
 */

const BACKEND_URL = 'http://localhost:4747';

test.describe('Archive Upload', () => {
  test.beforeEach(async ({ page }) => {
    // Mock server with zero repos so the onboarding flow transitions to the analyze form
    await page.route(`${BACKEND_URL}/api/repos`, (route) => route.fulfill({ json: [] }));
    await page.route(`${BACKEND_URL}/api/info`, (route) =>
      route.fulfill({
        json: { version: '1.0.0', launchContext: 'npx', nodeVersion: 'v22.0.0' },
      }),
    );
    await page.route(`${BACKEND_URL}/api/heartbeat`, (route) =>
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: ':ok\n\n',
      }),
    );

    // Mock upload and analyze endpoints for the full-flow test
    await page.route(`${BACKEND_URL}/api/upload`, (route) =>
      route.fulfill({
        status: 200,
        json: { path: '/tmp/test-project', name: 'test-project' },
      }),
    );
    await page.route(`${BACKEND_URL}/api/analyze`, (route) =>
      route.fulfill({
        status: 200,
        json: { jobId: 'test-123', status: 'queued' },
      }),
    );
  });

  test('shows Upload Archive tab in the RepoAnalyzer', async ({ page }) => {
    await page.goto('/');

    // Wait for the analyze form to appear (transition: onboarding -> success -> analyze)
    const archiveTab = page.getByRole('tab', { name: /Upload Archive/i });
    await expect(archiveTab).toBeVisible({ timeout: 20_000 });
  });

  test('clicking Upload Archive tab shows drop zone', async ({ page }) => {
    await page.goto('/');

    // Wait for tabs to load and click Archive tab
    const archiveTab = page.getByRole('tab', { name: /Upload Archive/i });
    await expect(archiveTab).toBeVisible({ timeout: 20_000 });
    await archiveTab.click();

    // Verify the drop zone is visible with correct instructions
    await expect(page.getByText(/Drop an archive here/i)).toBeVisible();
    await expect(page.getByText(/\.zip, \.tar, \.tar\.gz, \.tgz/i)).toBeVisible();
  });

  test('selecting a file shows file info and Remove button', async ({ page }) => {
    await page.goto('/');

    // Navigate to the Archive tab
    const archiveTab = page.getByRole('tab', { name: /Upload Archive/i });
    await expect(archiveTab).toBeVisible({ timeout: 20_000 });
    await archiveTab.click();

    // Attach a fake zip file via the hidden file input
    const fileInput = page.locator('input[type="file"][accept=".zip,.tar,.tar.gz,.tgz"]');
    const buffer = Buffer.from('PK\x03\x04fake-zip-content');
    await fileInput.setInputFiles({
      name: 'test-project.zip',
      mimeType: 'application/zip',
      buffer,
    });

    // Verify file info is shown
    await expect(page.getByText('test-project.zip')).toBeVisible();
    // The "Remove" button should appear
    await expect(page.getByText('Remove')).toBeVisible();
  });

  test('Remove button clears the selected file', async ({ page }) => {
    await page.goto('/');

    const archiveTab = page.getByRole('tab', { name: /Upload Archive/i });
    await expect(archiveTab).toBeVisible({ timeout: 20_000 });
    await archiveTab.click();

    // Select a file
    const fileInput = page.locator('input[type="file"][accept=".zip,.tar,.tar.gz,.tgz"]');
    const buffer = Buffer.from('PK\x03\x04fake-zip-content');
    await fileInput.setInputFiles({
      name: 'test-project.zip',
      mimeType: 'application/zip',
      buffer,
    });

    await expect(page.getByText('test-project.zip')).toBeVisible();

    // Click Remove
    await page.getByText('Remove').click();

    // File info should disappear; drop zone instructions should reappear
    await expect(page.getByText('test-project.zip')).not.toBeVisible();
    await expect(page.getByText(/Drop an archive here/i)).toBeVisible();
  });

  test('Analyze button is disabled without a file and enabled after selection', async ({
    page,
  }) => {
    await page.goto('/');

    const archiveTab = page.getByRole('tab', { name: /Upload Archive/i });
    await expect(archiveTab).toBeVisible({ timeout: 20_000 });
    await archiveTab.click();

    // Before file selection, analyze button should be disabled
    const analyzeButton = page.getByRole('button', { name: /Analyze Repository/i });
    await expect(analyzeButton).toBeDisabled();

    // Select a file
    const fileInput = page.locator('input[type="file"][accept=".zip,.tar,.tar.gz,.tgz"]');
    const buffer = Buffer.from('PK\x03\x04fake-zip-content');
    await fileInput.setInputFiles({
      name: 'test-project.zip',
      mimeType: 'application/zip',
      buffer,
    });

    // Now the analyze button should be enabled
    await expect(analyzeButton).toBeEnabled();
  });

  test('switching tabs clears the selected archive file', async ({ page }) => {
    await page.goto('/');

    const archiveTab = page.getByRole('tab', { name: /Upload Archive/i });
    await expect(archiveTab).toBeVisible({ timeout: 20_000 });
    await archiveTab.click();

    // Select a file
    const fileInput = page.locator('input[type="file"][accept=".zip,.tar,.tar.gz,.tgz"]');
    const buffer = Buffer.from('PK\x03\x04fake-zip-content');
    await fileInput.setInputFiles({
      name: 'test-project.zip',
      mimeType: 'application/zip',
      buffer,
    });

    await expect(page.getByText('test-project.zip')).toBeVisible();

    // Switch to GitHub URL tab and back
    await page.getByRole('tab', { name: 'GitHub URL' }).click();
    await archiveTab.click();

    // The file should be cleared — drop zone instructions should be back
    await expect(page.getByText('test-project.zip')).not.toBeVisible();
    await expect(page.getByText(/Drop an archive here/i)).toBeVisible();
  });
});
