const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

// ─── Configuration ───────────────────────────────────────────────────────────
const TOTAL_RUNS = 150;
const PROOFS_DIR = path.join(__dirname, "proofs");
const BOT_SCRIPT = path.join(__dirname, "bot.js");

// Ensure proofs directory exists
if (!fs.existsSync(PROOFS_DIR)) fs.mkdirSync(PROOFS_DIR, { recursive: true });

function log(msg) {
  console.log(`[RUNNER ${new Date().toISOString()}] ${msg}`);
}

// ─── Stats ───────────────────────────────────────────────────────────────────
let successes = 0;
let failures = 0;
const startTime = Date.now();

// ─── Main Loop ───────────────────────────────────────────────────────────────
(async () => {
  log(`═══════════════════════════════════════════════════════════`);
  log(`  NEIS Vote Bot — Mass Runner`);
  log(`  Target: ${TOTAL_RUNS} votes`);
  log(`  Proofs saved to: ${PROOFS_DIR}`);
  log(`═══════════════════════════════════════════════════════════`);

  for (let i = 1; i <= TOTAL_RUNS; i++) {
    const runId = `${Date.now()}_${i.toString().padStart(3, "0")}`;
    log(`\n──── Run ${i}/${TOTAL_RUNS} [${runId}] ────`);

    try {
      // Run bot.js as a subprocess with RUN_ID env var
      const output = execSync(
        `node "${BOT_SCRIPT}"`,
        {
          cwd: __dirname,
          env: {
            ...process.env,
            BOT_RUN_ID: runId,
            BOT_PROOFS_DIR: PROOFS_DIR,
          },
          timeout: 120000, // 2 minute timeout per run
          stdio: ["pipe", "pipe", "pipe"],
          maxBuffer: 10 * 1024 * 1024,
        }
      ).toString();

      // Check if vote was successful
      if (output.includes("VOTE CAST SUCCESSFULLY")) {
        successes++;
        log(`✅  Run ${i} — SUCCESS (${successes} wins / ${failures} fails)`);
      } else {
        failures++;
        log(`⚠️  Run ${i} — COMPLETED BUT UNCERTAIN (${successes}/${failures})`);
      }
    } catch (err) {
      failures++;
      const errOutput = err.stdout?.toString() || err.stderr?.toString() || err.message;
      log(`❌  Run ${i} — FAILED: ${errOutput.split("\n").pop()}`);
      log(`   (${successes} wins / ${failures} fails so far)`);
    }

    // Brief pause between runs to avoid rate limiting
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const rate = (successes / (elapsed / 60)).toFixed(1);
    log(`   ⏱  Elapsed: ${elapsed}s | Rate: ~${rate} votes/min`);
  }

  // ─── Summary ─────────────────────────────────────────────────────────────
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(0);
  log(`\n═══════════════════════════════════════════════════════════`);
  log(`  FINAL RESULTS`);
  log(`  ✅ Successes: ${successes}`);
  log(`  ❌ Failures:  ${failures}`);
  log(`  ⏱  Total time: ${totalTime}s`);
  log(`  📸 Proofs in: ${PROOFS_DIR}`);
  log(`═══════════════════════════════════════════════════════════`);
})();
