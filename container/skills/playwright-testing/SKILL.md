---
name: playwright-testing
description: Run Playwright end-to-end tests for web applications. Use to verify UI behavior, test user flows, catch regressions, and ensure web apps work correctly. Includes retry logic and debugging support.
allowed-tools: Bash(npx playwright:*), Bash(npm run test:*), Bash(node:*), Bash(ls:*), Bash(cat:*)
---

# Playwright Testing

## Quick start

```bash
# Install Playwright browsers (first time only)
npx playwright install

# Run all tests
npx playwright test

# Run specific test file
npx playwright test tests/example.spec.ts

# Run with headed browser (visible)
npx playwright test --headed

# Run specific test by name
npx playwright test -g "test name pattern"
```

## Configuration

Create `playwright.config.ts` in your project root. A template is available at:
```
/opt/nanoclaw/skills/playwright-testing/playwright.config.template.ts
```

Copy and customize:
```bash
cp /opt/nanoclaw/skills/playwright-testing/playwright.config.template.ts ./playwright.config.ts
```

## Running Tests

### Basic commands

```bash
# Run all tests
npx playwright test

# Run tests in a specific directory
npx playwright test tests/auth/

# Run a single test file
npx playwright test tests/login.spec.ts

# Run tests matching a pattern
npx playwright test -g "user can login"

# Run specific line numbers
npx playwright test tests/login.spec.ts:42
```

### Browser options

```bash
# Run in headed mode (see browser)
npx playwright test --headed

# Run in specific browser
npx playwright test --project=chromium
npx playwright test --project=firefox
npx playwright test --project=webkit

# Run in all browsers
npx playwright test --project=chromium --project=firefox --project=webkit
```

### Debug and inspect

```bash
# Debug mode (step through tests)
npx playwright test --debug

# UI mode (interactive test runner)
npx playwright test --ui

# Generate trace on failure
npx playwright test --trace on-first-retry

# View trace after test
npx playwright show-trace trace.zip

# View test report
npx playwright show-report
```

## Retry Strategy

### Built-in retries

Configure in `playwright.config.ts`:
```typescript
export default defineConfig({
  retries: 2,  // Retry failed tests 2 times
});
```

### Manual retry loop

For flaky tests, use a retry loop:

```bash
# Retry up to 3 times until tests pass
for i in 1 2 3; do
  npx playwright test && break
  echo "Attempt $i failed, retrying..."
  sleep 2
done
```

### Retry with exponential backoff

```bash
# Retry with increasing delays
attempt=1
max_attempts=5
delay=2

while [ $attempt -le $max_attempts ]; do
  echo "Attempt $attempt of $max_attempts..."
  if npx playwright test; then
    echo "Tests passed!"
    exit 0
  fi

  if [ $attempt -lt $max_attempts ]; then
    echo "Waiting ${delay}s before retry..."
    sleep $delay
    delay=$((delay * 2))  # Exponential backoff
  fi

  attempt=$((attempt + 1))
done

echo "All attempts failed"
exit 1
```

### Retry specific tests only

```bash
# Retry only failed test files
npx playwright test --last-failed

# Retry with more retries for flaky tests
npx playwright test --retries=5 tests/flaky.spec.ts
```

## Writing Tests

### Basic test structure

```typescript
import { test, expect } from '@playwright/test';

test('homepage has correct title', async ({ page }) => {
  await page.goto('https://example.com');

  await expect(page).toHaveTitle(/Example Domain/);
});

test('user can login', async ({ page }) => {
  await page.goto('https://example.com/login');

  await page.fill('input[name="email"]', 'user@example.com');
  await page.fill('input[name="password"]', 'password123');
  await page.click('button[type="submit"]');

  await expect(page).toHaveURL(/dashboard/);
});
```

### Using test fixtures

```typescript
import { test as base, expect } from '@playwright/test';

// Define custom fixture
const test = base.extend({
  authenticatedPage: async ({ page }, use) => {
    await page.goto('/login');
    await page.fill('input[name="email"]', 'test@example.com');
    await page.fill('input[name="password"]', 'password');
    await page.click('button[type="submit"]');
    await page.waitForURL(/dashboard/);
    await use(page);
  },
});

test('dashboard loads', async ({ authenticatedPage }) => {
  await expect(authenticatedPage).toHaveTitle(/Dashboard/);
});
```

### Using locators

```typescript
// Prefer role-based locators (most resilient)
await page.getByRole('button', { name: 'Submit' }).click();
await page.getByRole('textbox', { name: 'Email' }).fill('test@example.com');
await page.getByRole('link', { name: 'Learn more' }).click();

// Text content
await page.getByText('Welcome').click();

// Label associations
await page.getByLabel('Password').fill('secret');

// Placeholder
await page.getByPlaceholder('Search...').fill('query');

// Test ID (when role/text not available)
await page.getByTestId('submit-button').click();

// CSS selector (last resort)
await page.locator('.submit-btn').click();
```

### Assertions

```typescript
// Page assertions
await expect(page).toHaveTitle(/Dashboard/);
await expect(page).toHaveURL(/dashboard/);

// Element assertions
await expect(page.getByRole('heading')).toHaveText('Welcome');
await expect(page.getByRole('button')).toBeVisible();
await expect(page.getByRole('button')).toBeEnabled();
await expect(page.getByRole('checkbox')).toBeChecked();

// Negative assertions
await expect(page.getByRole('alert')).not.toBeVisible();

// Soft assertions (continue on failure)
await expect.soft(page.getByRole('heading')).toHaveText('Welcome');
```

## Handling Common Failures

### Timeout issues

```typescript
// Increase timeout for slow operations
await page.goto('/slow-page', { timeout: 60000 });

// Wait for specific conditions
await page.waitForSelector('.loaded', { timeout: 30000 });
await page.waitForLoadState('networkidle');

// Use expect with custom timeout
await expect(page.getByText('Done')).toBeVisible({ timeout: 10000 });
```

### Element not found

```typescript
// Wait for element before interacting
await page.waitForSelector('.dynamic-element');
await page.click('.dynamic-element');

// Use auto-waiting locators
await page.getByRole('button', { name: 'Submit' }).click();  // Auto-waits

// Check if element exists
const element = page.getByRole('button', { name: 'Optional' });
if (await element.count() > 0) {
  await element.click();
}
```

### Flaky network/API issues

```typescript
// Mock API responses
await page.route('**/api/data', route => {
  route.fulfill({
    status: 200,
    body: JSON.stringify({ data: 'mocked' }),
  });
});

// Wait for API calls
await page.waitForResponse(resp =>
  resp.url().includes('/api/data') && resp.status() === 200
);
```

### Race conditions

```typescript
// Wait for specific state
await page.waitForLoadState('domcontentloaded');
await page.waitForLoadState('networkidle');

// Chain wait operations
await page.getByRole('button').click();
await page.waitForURL(/success/);
await expect(page.getByText('Success')).toBeVisible();
```

## Debugging Tests

### Visual debugging

```bash
# Debug mode with Playwright Inspector
npx playwright test --debug

# Debug specific test
npx playwright test --debug tests/login.spec.ts

# Step through with UI mode
npx playwright test --ui
```

### Screenshots and traces

```typescript
// Configure in test
test('my test', async ({ page }) => {
  await page.screenshot({ path: 'debug.png' });

  // Trace for detailed debugging
  await page.context().tracing.start({ screenshots: true, snapshots: true });

  // ... test actions ...

  await page.context().tracing.stop({ path: 'trace.zip' });
});
```

### Console and error logging

```typescript
test('debug test', async ({ page }) => {
  // Log console messages
  page.on('console', msg => console.log('Browser:', msg.text()));

  // Log page errors
  page.on('pageerror', err => console.error('Page error:', err.message));

  await page.goto('/test');
});
```

### View failure artifacts

```bash
# Show HTML report with traces
npx playwright show-report

# View specific trace
npx playwright show-trace test-results/.../trace.zip
```

## Test Patterns

### Page Object Model

```typescript
// pages/LoginPage.ts
export class LoginPage {
  constructor(private page: Page) {}

  async goto() {
    await this.page.goto('/login');
  }

  async login(email: string, password: string) {
    await this.page.getByLabel('Email').fill(email);
    await this.page.getByLabel('Password').fill(password);
    await this.page.getByRole('button', { name: 'Sign in' }).click();
  }
}

// tests/login.spec.ts
import { LoginPage } from '../pages/LoginPage';

test('user can login', async ({ page }) => {
  const loginPage = new LoginPage(page);
  await loginPage.goto();
  await loginPage.login('user@example.com', 'password');

  await expect(page).toHaveURL(/dashboard/);
});
```

### Test groups and hooks

```typescript
test.describe('Authentication', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('login works', async ({ page }) => {
    // ...
  });

  test('logout works', async ({ page }) => {
    // ...
  });

  test.afterEach(async ({ page }) => {
    // Cleanup
  });
});
```

### Parameterized tests

```typescript
const credentials = [
  { email: 'user1@example.com', password: 'pass1' },
  { email: 'user2@example.com', password: 'pass2' },
];

for (const { email, password } of credentials) {
  test(`login with ${email}`, async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/dashboard/);
  });
}
```

## CI/CD Integration

### GitHub Actions

```yaml
- name: Install Playwright Browsers
  run: npx playwright install --with-deps

- name: Run Playwright tests
  run: npx playwright test

- name: Upload test artifacts
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: playwright-report
    path: playwright-report/
```

### Parallel execution

```typescript
// playwright.config.ts
export default defineConfig({
  workers: process.env.CI ? 4 : 1,  // Parallel in CI
  reporter: [['html'], ['json', { outputFile: 'results.json' }]],
});
```

## Best Practices

1. **Use role-based locators** - Most resilient to UI changes
2. **Avoid hardcoded waits** - Use auto-waiting assertions instead of `page.waitForTimeout()`
3. **Keep tests isolated** - Each test should be independent
4. **Use test fixtures** - Share setup/teardown logic
5. **Mock external services** - Tests should be reliable and fast
6. **Capture traces on failure** - Helps debug CI failures
7. **Use soft assertions** - When you want to see all failures at once
8. **Retry flaky tests** - But also fix the root cause
