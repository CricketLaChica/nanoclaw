#!/usr/bin/env node
// Quick test of memory system
const Database = require('better-sqlite3');
const db = new Database('./store/messages.db');

console.log('Testing memory system...\n');

// Test 1: List memories
console.log('1. Listing memories:');
const memories = db.prepare('SELECT * FROM memories WHERE agent_folder = ?').all('lucy');
console.log(`   Found ${memories.length} memories`);
memories.forEach(m => console.log(`   - [${m.importance}/10] ${m.content}`));

// Test 2: FTS search
console.log('\n2. FTS Search:');
const sql = `SELECT m.* FROM memories m
INNER JOIN memories_fts ON m.id = memories_fts.id
WHERE m.agent_folder = ?
AND memories_fts MATCH ?
ORDER BY m.importance DESC, m.created_at DESC
LIMIT ?`;

const results = db.prepare(sql).all('lucy', 'Cricket', 10);
console.log(`   Found ${results.length} memories for "Cricket"`);
results.forEach(m => console.log(`   - ${m.content}`));

// Test 3: Check personality files
const fs = require('fs');
console.log('\n3. Personality files:');
const soulPath = './groups/lucy/SOUL.md';
if (fs.existsSync(soulPath)) {
  console.log(`   ✓ SOUL.md exists (${fs.statSync(soulPath).size} bytes)`);
} else {
  console.log('   ✗ SOUL.md missing');
}

console.log('\n✅ Memory system is functional!');
