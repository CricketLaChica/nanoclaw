---
name: playwright-cli
description: Automates browser interactions for web testing, form filling, screenshots, and data extraction. Use when the user needs to navigate websites, interact with web pages, fill forms, take screenshots, test web applications, or extract information from web pages.
allowed-tools: Bash
---

# Playwright CLI

Browser automation for web testing, form filling, screenshots, and data extraction.

## Installation

```bash
# Install playwright and chromium browser
npm install -g playwright
npx playwright install chromium

# Or install locally in your project
npm install playwright
npx playwright install chromium
```

## Quick Start

```bash
# Open a browser and navigate
npx playwright open https://example.com

# Take a screenshot
npx playwright screenshot https://example.com screenshot.png

# Run a test script
npx playwright test my-test.spec.ts
```

## Common Commands

### Screenshots

```bash
# Full page screenshot
npx playwright screenshot --full-page https://example.com full-page.png

# Mobile viewport
npx playwright screenshot --viewport-size=375,667 https://example.com mobile.png

# Wait for specific element
npx playwright screenshot --selector=".main-content" https://example.com content.png
```

### Code Generation

```bash
# Record interactions and generate code
npx playwright codegen https://example.com

# Generate to file
npx playwright codegen --output=test.spec.ts https://example.com

# Target specific language
npx playwright codegen --target=python https://example.com
```

### Testing

```bash
# Run all tests
npx playwright test

# Run specific test file
npx playwright test login.spec.ts

# Run in headed mode (visible browser)
npx playwright test --headed

# Run in specific browser
npx playwright test --project=firefox
npx playwright test --project=webkit
```

## Programmatic Usage

### Basic Navigation & Screenshot

```typescript
import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto('https://example.com');
  await page.screenshot({ path: 'screenshot.png', fullPage: true });

  await browser.close();
}

main();
```

### Form Interaction

```typescript
import { chromium } from 'playwright';

async function fillForm() {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  await page.goto('https://example.com/login');

  // Fill form fields
  await page.fill('input[name="email"]', 'user@example.com');
  await page.fill('input[name="password"]', 'secretpassword');

  // Click submit
  await page.click('button[type="submit"]');

  // Wait for navigation
  await page.waitForURL('**/dashboard');

  await browser.close();
}
```

### Data Extraction

```typescript
import { chromium } from 'playwright';

async function scrapeData() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.goto('https://example.com/products');

  // Extract text content
  const products = await page.$$eval('.product-card', cards =>
    cards.map(card => ({
      name: card.querySelector('.product-name')?.textContent?.trim(),
      price: card.querySelector('.price')?.textContent?.trim(),
    }))
  );

  console.log(products);
  await browser.close();
}
```

### Handle Dynamic Content

```typescript
import { chromium } from 'playwright';

async function handleDynamicContent() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.goto('https://example.com');

  // Wait for element to appear
  await page.waitForSelector('.dynamic-content', { timeout: 10000 });

  // Wait for network to be idle
  await page.waitForLoadState('networkidle');

  // Wait for specific response
  const responsePromise = page.waitForResponse('**/api/data');
  await page.click('button.load-more');
  const response = await responsePromise;

  await browser.close();
}
```

### Authentication

```typescript
import { chromium } from 'playwright';

async function withAuth() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    // Set cookies
    storageState: 'auth-state.json',
  });

  // Or set basic auth
  const page = await context.newPage();
  await page.setExtraHTTPHeaders({
    'Authorization': `Basic ${btoa('user:password')}`,
  });

  await page.goto('https://protected.example.com');
  await browser.close();
}
```

### Save & Restore Session

```typescript
import { chromium } from 'playwright';

async function saveSession() {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  // Login...
  await page.goto('https://example.com/login');
  await page.fill('#email', 'user@example.com');
  await page.fill('#password', 'password');
  await page.click('button[type="submit"]');
  await page.waitForURL('**/dashboard');

  // Save auth state
  await context.storageState({ path: 'auth-state.json' });
  await browser.close();
}

async function restoreSession() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    storageState: 'auth-state.json', // Restore session
  });
  const page = await context.newPage();

  await page.goto('https://example.com/dashboard');
  // Already logged in!
}
```

## Useful Options

```bash
# Slow down execution (useful for debugging)
npx playwright test --slow-mo=500

# Debug mode with inspector
npx playwright test --debug

# Generate trace for debugging
npx playwright test --trace on

# View trace after test
npx playwright show-trace trace.zip

# Take screenshot on failure
npx playwright test --screenshot on-failure

# Video recording
npx playwright test --video on
```

## NanoClaw Integration

When running inside a NanoClaw container:

```bash
# Screenshots save to workspace
npx playwright screenshot https://example.com /workspace/screenshot.png

# Test results go to workspace
npx playwright test --reporter=html --output=/workspace/test-results/
```

## Common Patterns

### Wait for Page Load States

```typescript
await page.waitForLoadState('domcontentloaded');  // DOM ready
await page.waitForLoadState('load');              // All resources loaded
await page.waitForLoadState('networkidle');       // No network activity
```

### Handle Dialogs

```typescript
page.on('dialog', async dialog => {
  console.log(dialog.message());
  await dialog.accept(); // or dialog.dismiss()
});
```

### Intercept Requests

```typescript
await page.route('**/api/**', route => {
  console.log('Intercepted:', route.request().url());
  route.continue();
});

// Mock responses
await page.route('**/api/users', route => {
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([{ name: 'Test User' }]),
  });
});
```

### Handle Multiple Tabs

```typescript
const [newPage] = await Promise.all([
  context.waitForEvent('page'),
  page.click('a[target="_blank"]'),
]);
await newPage.waitForLoadState();
```

## Troubleshooting

**Browser not found:**
```bash
npx playwright install chromium
```

**Headless mode issues:**
```bash
# Run with visible browser for debugging
npx playwright test --headed --debug
```

**Timeout errors:**
```bash
# Increase timeout
npx playwright test --timeout=60000
```

**Memory issues:**
```typescript
// Close pages when done
await page.close();
// Or reuse context
const context = await browser.newContext();
```
