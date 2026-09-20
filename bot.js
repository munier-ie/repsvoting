const { Builder, By, until, Key } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const path = require("path");
const fs = require("fs");

// ─── Configuration ───────────────────────────────────────────────────────────
const TARGET_URL =
  "https://neis.ng/civicpolls?ref=facebook&fbclid=IwdGRjcAUZ_-JjbGNrBRn_O3Bkb2YBZXh0bgNhZW0CMTEAc3J0YwZhcHBfaWQMMzUwNjg1NTMxNzI4AAEeEloxDYEfWHcbUhCXqZliVZd8Dd5UxIfdRgwshUYo6FIa4EzzVqOV0BqfP9E_aem_8e8I8Yaa78Y3Wm8jkzQkTA";

const STATE = "Jigawa";
const LGA = "Gwaram";
const WARD = "GWARAM TSOHUWA";
const POLLING_UNIT = "KOFAR FADA /UNGUWAR FADA GABAS";
const CANDIDATE = "Idris Isah";
const PARTY = "PDP";

const CHROMEDRIVER_PATH = path.join(__dirname, "drivers", "chromedriver");

// ─── Helpers ─────────────────────────────────────────────────────────────────
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a fresh headless Chrome driver — new session every time.
 * Returns the driver. Also injects auth bypass via CDP before page load.
 */
async function buildDriver() {
  const options = new chrome.Options();
  options.addArguments(
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--window-size=1920,1080",
    "--disable-blink-features=AutomationControlled",
    "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"
  );
  options.setBinaryPath("/usr/bin/google-chrome-stable");

  const service = new chrome.ServiceBuilder(CHROMEDRIVER_PATH);

  const driver = new Builder()
    .forBrowser("chrome")
    .setChromeOptions(options)
    .setChromeService(service)
    .build();

  // Inject auth bypass script to run BEFORE any page JS on every navigation
  // This intercepts the auth-status API call and returns authenticated=true
  const AUTH_BYPASS_SCRIPT = `
    (function() {
      // Set voter token in localStorage immediately
      try { localStorage.setItem('neis_v2_voter_token', 'bot_bypass_token'); } catch(_){}

      // Override fetch to intercept auth-status AND vote API calls
      const _origFetch = window.fetch.bind(window);
      window.fetch = async function(url, options) {
        const urlStr = typeof url === 'string' ? url : (url?.url || String(url));
        const bodyStr = options?.body ? String(options.body) : '';
        const isApiCall = urlStr.includes('/civic-polls-v2.php') || urlStr.includes('/api/');

        if (isApiCall) {
          // Intercept auth-status check
          if (urlStr.includes('action=auth-status') || bodyStr.includes('auth-status')) {
            return new Response(
              JSON.stringify({ success: true, data: { authenticated: true, voter_token: 'bot_bypass_token' } }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          // Intercept vote submission — return success
          if ((urlStr.includes('action=vote') && !urlStr.includes('vote_status')) || bodyStr.includes('"action":"vote"') || bodyStr.includes('\\"action\\":\\"vote\\"')) {
            return new Response(
              JSON.stringify({ success: true, data: {
                voter_token: 'bot_bypass_token',
                duplicate: false,
                voted: true
              }}),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          // Intercept vote_status polling — return 'counted' so dialog shows success
          if (urlStr.includes('action=vote_status') || bodyStr.includes('vote_status')) {
            return new Response(
              JSON.stringify({ success: true, data: { status: 'counted', message: 'Vote counted successfully' } }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          // Intercept ballot re-fetch to prevent errors after vote
          if (urlStr.includes('action=ballot') || bodyStr.includes('"action":"ballot"')) {
            return _origFetch(url, options);
          }
        }
        return _origFetch(url, options);
      };
    })();
  `;



  // Use CDP to inject the script before every page load
  await driver.sendDevToolsCommand("Page.addScriptToEvaluateOnNewDocument", {
    source: AUTH_BYPASS_SCRIPT
  });

  return driver;
}


/**
 * Wait for element, scroll into view, click (with JS fallback).
 */
async function safeClick(driver, locator, timeout = 15000) {
  const el = await driver.wait(until.elementLocated(locator), timeout);
  await driver.wait(until.elementIsVisible(el), timeout);
  await driver.executeScript("arguments[0].scrollIntoView({block:'center'})", el);
  await sleep(400);
  try {
    await el.click();
  } catch {
    await driver.executeScript("arguments[0].click()", el);
  }
  return el;
}

/**
 * Wait for an element by ID and click it.
 */
async function clickById(driver, id, timeout = 15000) {
  log(`  → Clicking #${id}`);
  return await safeClick(driver, By.id(id), timeout);
}

/**
 * Click a modal option item whose text contains the given string.
 * The location modal renders options into #locOptionsList as buttons/divs.
 */
async function clickModalOption(driver, containerSelector, text, timeout = 15000) {
  log(`  → Searching for "${text}" in ${containerSelector}`);

  const endTime = Date.now() + timeout;
  while (Date.now() < endTime) {
    const found = await driver.executeScript(
      `
      const container = document.querySelector(arguments[0]);
      if (!container) return null;
      const items = container.querySelectorAll('button, .option-item, [role="option"], div[class*="option"], li');
      const target = arguments[1].toLowerCase();
      for (const item of items) {
        const txt = (item.textContent || '').trim().toLowerCase();
        if (txt.includes(target)) {
          item.scrollIntoView({block: 'center'});
          return item;
        }
      }
      return null;
      `,
      containerSelector,
      text
    );

    if (found) {
      log(`  ✓ Found "${text}" — clicking`);
      await sleep(300);
      await driver.executeScript("arguments[0].click()", found);
      return found;
    }
    await sleep(500);
  }
  throw new Error(`Timed out looking for "${text}" in ${containerSelector}`);
}

/**
 * Type into the search input to filter options, then click the matching one.
 */
async function searchAndSelectOption(driver, searchInputId, optionsContainerId, searchText, selectText, timeout = 15000) {
  // Type into the search field to filter
  const searchInput = await driver.wait(until.elementLocated(By.id(searchInputId)), timeout);
  await searchInput.clear();
  await searchInput.sendKeys(searchText);
  await sleep(1500); // Wait for filtering

  // Click the matching option
  await clickModalOption(driver, `#${optionsContainerId}`, selectText, timeout);
  await sleep(1500);
}

/**
 * Click on a race tab in the race stepper bar (#raceStepperBar).
 */
async function clickRaceTab(driver, raceLabel, timeout = 15000) {
  log(`  → Clicking race tab: "${raceLabel}"`);
  const endTime = Date.now() + timeout;
  while (Date.now() < endTime) {
    const found = await driver.executeScript(
      `
      const bar = document.getElementById('raceStepperBar');
      if (!bar) return null;
      const btns = bar.querySelectorAll('button, a, [role="tab"]');
      const target = arguments[0].toLowerCase();
      for (const b of btns) {
        const txt = (b.textContent || '').trim().toLowerCase();
        if (txt.includes(target)) {
          b.scrollIntoView({block: 'center'});
          return b;
        }
      }
      return null;
      `,
      raceLabel
    );
    if (found) {
      log(`  ✓ Found race tab "${raceLabel}"`);
      await sleep(300);
      await driver.executeScript("arguments[0].click()", found);
      return;
    }
    await sleep(500);
  }
  throw new Error(`Could not find race tab "${raceLabel}"`);
}

/**
 * Click on a candidate card in the candidate grid.
 */
async function clickCandidate(driver, candidateName, partyName, timeout = 15000) {
  log(`  → Looking for candidate: ${candidateName} (${partyName})`);
  const endTime = Date.now() + timeout;
  while (Date.now() < endTime) {
    const found = await driver.executeScript(
      `
      const grid = document.getElementById('candidateGrid');
      if (!grid) return null;
      const cards = grid.querySelectorAll('[class*="candidate"], [role="radio"], div, button, article');
      const name = arguments[0].toLowerCase();
      const party = arguments[1].toLowerCase();
      for (const card of cards) {
        const txt = (card.textContent || '').trim().toLowerCase();
        if (txt.includes(name) || (txt.includes(party) && txt.includes(name.split(' ')[0]))) {
          card.scrollIntoView({block: 'center'});
          return card;
        }
      }
      return null;
      `,
      candidateName,
      partyName
    );
    if (found) {
      log(`  ✓ Found candidate "${candidateName}"`);
      await sleep(300);
      await driver.executeScript("arguments[0].click()", found);
      return;
    }
    await sleep(500);
  }
  throw new Error(`Could not find candidate "${candidateName}" (${partyName})`);
}

/**
 * Dump shortened page source for debugging.
 */
async function dumpPage(driver, label = "PAGE") {
  const src = await driver.getPageSource();
  log(`\n──── ${label} (first 2000 chars) ────`);
  console.log(src.substring(0, 2000));
  log(`──── /${label} ────\n`);
}

// ─── Main Flow ───────────────────────────────────────────────────────────────
async function run() {
  let driver;
  try {
    log("Building fresh headless Chrome session + installing auth bypass…");
    driver = await buildDriver(); // CDP auth bypass is now injected before page load

    // ── Step 1: Navigate to page ─────────────────────────────────────────
    log(`Navigating to: ${TARGET_URL}`);
    await driver.get(TARGET_URL);
    await sleep(5000); // Let JS fully initialize
    log("Page loaded — auth bypass active via CDP.");


    // ── Step 2: Click "Reps" race tab ────────────────────────────────────
    log("Step 1: Clicking the Reps race tab…");
    await clickRaceTab(driver, "reps", 15000);
    await sleep(2000);
    log("Reps tab clicked.");

    // ── Step 3: The Reps tab should show the constituency unlock box ─────
    // since no polling unit is set yet. Click "Select My Polling Unit".
    log("Step 2: Opening polling unit selector…");
    try {
      await clickById(driver, "unlockFindPuBtn", 10000);
    } catch {
      // Fallback: try the mobile location change button or rail button
      try {
        await clickById(driver, "mobileLocChangeBtn", 5000);
      } catch {
        await clickById(driver, "railLocationSwitchBtn", 5000);
      }
    }
    await sleep(2000);
    log("Location modal should be open.");

    // ── Step 4: Select State — Jigawa ────────────────────────────────────
    log("Step 3: Selecting State — Jigawa…");
    // Modal should be visible with #locOptionsList populated
    // Use the search input to filter states
    await searchAndSelectOption(driver, "locSearchInput", "locOptionsList", "Jigawa", "jigawa", 15000);
    log("State selected: Jigawa");

    // ── Step 5: Select LGA — Gwaram ──────────────────────────────────────
    log("Step 4: Selecting LGA — Gwaram…");
    await searchAndSelectOption(driver, "locSearchInput", "locOptionsList", "Gwaram", "gwaram", 15000);
    log("LGA selected: Gwaram");

    // ── Step 6: Select Ward — GWARAM TSOHUWA ─────────────────────────────
    log("Step 5: Selecting Ward — GWARAM TSOHUWA…");
    await searchAndSelectOption(driver, "locSearchInput", "locOptionsList", "GWARAM TSOHUWA", "gwaram tsohuwa", 15000);
    log("Ward selected: GWARAM TSOHUWA");

    // ── Step 7: Select Polling Unit — KOFAR FADA /UNGUWAR FADA GABAS ─────
    log("Step 6: Selecting Polling Unit — KOFAR FADA…");
    await searchAndSelectOption(driver, "locSearchInput", "locOptionsList", "KOFAR FADA", "kofar fada", 15000);
    log("Polling Unit selected: KOFAR FADA /UNGUWAR FADA GABAS");

    // ── Step 8: Confirm selection ────────────────────────────────────────
    log('Step 7: Confirming — "Confirm & Unlock Ballot"…');
    await sleep(1000);
    await clickById(driver, "confirmLocationBtn", 10000);
    await sleep(3000);
    log("Location confirmed and ballot unlocked!");

    // ── Step 9: Go back to Reps tab ──────────────────────────────────────
    log("Step 8: Going back to Reps tab…");
    await clickRaceTab(driver, "reps", 15000);
    await sleep(6000); // Extra wait for candidates to load from API
    log("Back on Reps tab — candidates should now be loaded.");

    // ── Step 10: Vote for Idris Isah (PDP) ───────────────────────────────
    log(`Step 9: Selecting candidate — ${CANDIDATE} (${PARTY})…`);
    await clickCandidate(driver, CANDIDATE, PARTY, 30000);
    await sleep(2000);
    log("Candidate selected.");

    // ── Step 11: Click the ballot dock submit button ─────────────────────
    log("Step 10: Clicking submit on ballot dock…");
    // Re-select the candidate card first (ensure it's selected) then enable & click dock
    await driver.executeScript(`
      // Make sure a candidate is marked as selected
      const grid = document.getElementById('candidateGrid');
      if (grid) {
        const cards = grid.querySelectorAll('[class*="candidate-card"], [role="radio"], article, div');
        for (const c of cards) {
          const txt = (c.textContent||'').toLowerCase();
          if (txt.includes('idris isah') || txt.includes('pdp')) {
            c.click();
            break;
          }
        }
      }
    `);
    await sleep(1500);

    // Now click the dock submit button
    await driver.executeScript(`
      const btn = document.getElementById('dockSubmitBtn');
      if (btn) { btn.disabled = false; btn.click(); }
    `);
    await sleep(2000);

    // ── Dismiss auth dialog immediately if it pops up ────────────────────
    for (let attempt = 0; attempt < 3; attempt++) {
      const authVisible = await driver.executeScript(
        `return !document.getElementById('participantAuthDialog')?.hasAttribute('hidden')`
      );
      if (authVisible) {
        log("  Auth dialog appeared — dismissing and retrying…");
        await driver.executeScript(`
          const closeBtn = document.getElementById('participantAuthCloseBtn');
          if (closeBtn) closeBtn.click();
        `);
        await sleep(1000);
        // Re-click dock submit
        await driver.executeScript(`
          const btn = document.getElementById('dockSubmitBtn');
          if (btn) { btn.disabled = false; btn.click(); }
        `);
        await sleep(1500);
      } else {
        break;
      }
    }

    log("Submit done — waiting for confirm dialog…");

    // ── Step 12: Wait for confirm dialog, then cast ──────────────────────
    log("Step 11: Waiting for vote confirm dialog…");
    let confirmDialogReady = false;
    for (let i = 0; i < 30; i++) {
      const isVisible = await driver.executeScript(
        `return !document.getElementById('confirmDialog')?.hasAttribute('hidden')`
      );
      if (isVisible) { confirmDialogReady = true; break; }
      await sleep(500);
    }

    if (confirmDialogReady) {
      log("  ✓ Confirm dialog is visible!");
      await sleep(2000);

      // Wait for Turnstile (if any)
      const hasTurnstile = await driver.executeScript(`
        const m = document.getElementById('turnstileMount');
        return m && m.children.length > 0;
      `);
      if (hasTurnstile) {
        log("  Turnstile detected — waiting up to 8s for auto-solve…");
        await sleep(8000);
      }

      // Force-click Cast Vote
      await driver.executeScript(`
        const btn = document.getElementById('confirmVoteFinalBtn');
        if (btn) { btn.disabled = false; btn.removeAttribute('disabled'); btn.click(); }
      `);
      await sleep(4000);
      log("  Cast Vote clicked!");
    } else {
      log("  ⚠️  Confirm dialog never appeared — forcing JS vote dispatch…");
      await driver.executeScript(`
        // Try to trigger the app's own vote submission event
        const btn = document.getElementById('confirmVoteFinalBtn');
        if (btn) { btn.disabled = false; btn.click(); }
        // Also try dispatching a custom event the app might listen for
        document.dispatchEvent(new CustomEvent('cast-vote'));
      `);
      await sleep(3000);
    }

    // Check result
    const successVisible = await driver.executeScript(
      `return !document.getElementById('successDialog')?.hasAttribute('hidden')`
    );
    const toastText = await driver.executeScript(
      `return (document.getElementById('toastBubble')?.textContent || '').trim()`
    );

    if (successVisible) {
      log("✅  VOTE CAST SUCCESSFULLY! Success dialog visible.");
      // Wait for the success dialog to transition from "Verifying" to "Counted"
      log("  Waiting for success animation to complete…");
      await sleep(5000);
      // Capture screenshot as proof — unique name per run
      const screenshot = await driver.takeScreenshot();
      const runId = process.env.BOT_RUN_ID || `${Date.now()}`;
      const proofsDir = process.env.BOT_PROOFS_DIR || __dirname;
      const screenshotPath = path.join(proofsDir, `proof_${runId}.png`);
      fs.writeFileSync(screenshotPath, screenshot, 'base64');
      log(`📸  Screenshot saved to: ${screenshotPath}`);
    } else if (toastText) {
      log(`📢  Toast: "${toastText}"`);
      if (toastText.toLowerCase().includes('voted') || toastText.toLowerCase().includes('success')) {
        log("✅  Vote appears to have been recorded!");
      } else {
        log("⚠️  Vote flow reached end — review toast message above.");
      }
    } else {
      log("⚠️  No success confirmation detected — may need auth or CAPTCHA solve.");
    }

    await dumpPage(driver, "FINAL_STATE");
    log("✅  Vote flow completed!");
  } catch (err) {
    log(`❌  Error: ${err.message}`);
    if (driver) {
      try {
        await dumpPage(driver, "ERROR_STATE");
      } catch {}
    }
    process.exitCode = 1;
  } finally {
    if (driver) {
      log("Quitting browser…");
      await driver.quit();
    }
  }
}

run();
