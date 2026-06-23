import test from 'node:test';
import assert from 'node:assert/strict';
import db, { closeDatabase, insertMemory, insertVector, archiveExpiredMemories } from '../src/database.js';
import { extractHeuristic } from '../src/extractor-heuristic.js';
import { getOptimizedContext } from '../src/search.js';
import { generateEmbedding } from '../src/embeddings.js';

test.before(async () => {
  db.exec('DELETE FROM memories_vec; DELETE FROM memories; DELETE FROM contradictions; DELETE FROM provenance;');
});

test.after(() => {
  closeDatabase();
});

test('Context Bloat Prevention & Optimization', async (t) => {
  await t.test('1. Strip fenced code blocks from heuristic extraction', () => {
    const textWithCode = `
      Some conversational text.
      Remember: The API port is 8080.
      \`\`\`javascript
      // Example code block that shouldn't trigger implicit saves
      const port = 3000;
      we decided to use port 3000;
      \`\`\`
      We decided to switch to HSL colors for our theme.
    `;
    
    const facts = extractHeuristic(textWithCode);
    
    // Check that we extracted the explicit note and decision from the conversational text
    const contents = facts.map(f => f.content);
    assert.ok(contents.some(c => c.includes('The API port is 8080')), 'Should extract explicit save outside code block');
    assert.ok(contents.some(c => c.includes('Decision: HSL colors for our theme')), 'Should extract implicit decision outside code block');
    
    // Check that the text inside the fenced code block was NOT processed
    assert.ok(!contents.some(c => c.includes('port 3000')), 'Should not extract decisions or preferences from code blocks');
  });

  await t.test('2. Memory Auto-Expiry (archiving after 14 days)', () => {
    // 1. Insert a transient note (created 15 days ago)
    const oldTime = Math.floor(Date.now() / 1000) - (15 * 24 * 60 * 60);
    const idExpired = db.prepare(`
      INSERT INTO memories (content, importance_score, created_at, last_accessed, namespace)
      VALUES (?, ?, ?, ?, ?)
    `).run('Note: This is a transient note that should be expired.', 0.9, oldTime, oldTime, 'shared').lastInsertRowid;

    // 2. Insert a permanent rule (created 15 days ago)
    const idPermanent = db.prepare(`
      INSERT INTO memories (content, importance_score, created_at, last_accessed, namespace)
      VALUES (?, ?, ?, ?, ?)
    `).run('Rule: Always follow ES module conventions.', 0.9, oldTime, oldTime, 'shared').lastInsertRowid;

    // Run auto-expiry check
    const archivedCount = archiveExpiredMemories();
    assert.ok(archivedCount > 0, 'Should archive at least one expired memory');

    // Retrieve both
    const rowExpired = db.prepare('SELECT valid_until FROM memories WHERE id = ?').get(idExpired);
    const rowPermanent = db.prepare('SELECT valid_until FROM memories WHERE id = ?').get(idPermanent);

    assert.ok(rowExpired.valid_until !== null, 'Transient memory should be archived (valid_until populated)');
    assert.ok(rowPermanent.valid_until === null, 'Core rule should remain active (valid_until is NULL)');
  });

  await t.test('3. Dynamic Token Budgeting based on Intent', async () => {
    // Clean memories to avoid interference
    db.exec('DELETE FROM memories_vec; DELETE FROM memories; DELETE FROM contradictions; DELETE FROM provenance;');
    
    // 1. Create a compiler concept entity to enable graph hopping for all related memories
    db.prepare("INSERT OR IGNORE INTO entities (name, type) VALUES ('compiler', 'concept')").run();

    // 2. Seed 20 long and semantically distinct memories containing the word "compiler"
    // to bypass the Jaccard diversity filter while remaining hopped in search.
    const paragraphWords = [
      "compiler optimizing phase converts high-level abstract syntax trees into intermediate representations using static single assignment form to allow dead code elimination and loop invariant code motion. The AST transformation optimizes control flow graph representation. We perform analysis on local basic blocks to determine optimization candidate lines. This reduces overall compilation duration and output size.",
      "compiler backend compiler target code generator emits assembly language specifically for AMD64 architectures using instruction selection algorithms like maximal munch and instruction scheduling passes. The code generator translates intermediate code into target machine instructions. We optimize instructions using peephole optimization techniques. This produces highly efficient machine code.",
      "compiler register allocator registers variables to physical registers using graph coloring heuristic algorithm with Chaitin-Briggs optimization to minimize stack spills and coalesce registers. The allocator builds interference graph for active variables. We determine spill costs for each register candidate. This minimizes memory load and store instructions.",
      "compiler just-in-time compilation system compiles bytecode dynamically to native machine instructions at runtime based on profiling data collected from interpreter execution counts. The JIT compiler optimizes hot methods at runtime. We perform dynamic compilation to generate optimized code. This speeds up execution of frequently called functions.",
      "compiler frontend lexer lexes character streams into tokens using deterministic finite automata and parser parses tokens using LALR parsing tables generated from grammar rules. The lexer splits source text into grammar tokens. We parse syntax tokens to construct abstract syntax tree. This validates source syntax correctness.",
      "compiler garbage collector manages memory allocation on heap using generational mark-sweep algorithm with write barriers to track pointers and run compaction phases to avoid fragmentation. The collector reclaims unused object memory. We run collection cycles when heap memory limit is reached. This prevents memory leaks and out of memory errors.",
      "compiler static linker merges multiple ELF object files resolving symbolic references and applying relocations to build executable output files linked with shared dynamic libraries. The linker combines object sections into output segments. We resolve external symbols against library export tables. This produces standalone executable file.",
      "compiler function inlining inline function calls replaces call sites with callee body based on call site frequency and callee size heuristics to remove call stack frame overheads. The inliner evaluates benefit of function expansion. We replace call instruction with function body code. This eliminates call return overhead.",
      "compiler loop optimizer performs loop unrolling vectorization using SIMD instructions to exploit hardware level parallelism and optimize array access patterns in critical loops. The loop optimizer transforms loop structure. We run vector instructions to process multiple data elements. This speeds up array processing loops.",
      "compiler escape analyzer detects if object lifetimes exceed function scope allowing compiler allocation on stack instead of heap to avoid garbage collection pressure and thread locking. The escape analyzer checks if pointer escapes. We allocate non-escaping objects on call stack. This reduces allocation and deallocation cost.",
      "compiler constant folder constant folding constant propagation evaluates arithmetic expressions at compile time and simplifies algebraic identities to reduce runtime execution CPU cycles. The constant folder simplifies static math operations. We propagate constant values through variable assignments. This eliminates runtime math calculations.",
      "compiler dataflow analyzer computes reaching definitions liveness analysis available expressions using iterative framework lattice equations to solve equations at fixed point convergence. The dataflow analyzer runs iterative solver. We analyze variable definitions across CFG nodes. This provides basis for compiler optimization.",
      "compiler control flow graph constructor builds CFG nodes representing basic blocks with terminal instructions and edges representing branch targets to analyze dominator trees and frontiers. The CFG constructor parses program flow. We build dominator tree to find loop headers. This enables structured loop optimization.",
      "compiler exception handling runtime generates table-driven exception landing pads to unwind stack frames without runtime cost during normal execution paths when no exceptions are thrown. The exception system handles try catch blocks. We unwind call stack when exception occurs. This avoids performance overhead when no errors occur.",
      "compiler macro preprocessor expands macro definitions templates using hygienic macro expansion algorithms to prevent variable capture and allow type-safe metaprogramming generation. The preprocessor replaces macro calls with expanded code. We resolve macro parameters without name collision. This enables powerful code generation templates.",
      "compiler debug information generator outputs DWARF symbol tables mapping machine instructions to source code file lines and tracking variable memory stack slot locations for debuggers. The debug generator writes symbol information. We map assembly address to source line number. This allows debuggers to show source code.",
      "compiler concurrency model supports threads mutex locks atomic operations memory barriers memory fence instructions to implement memory consistency model guarantees across multiple cores. The concurrency engine handles memory ordering. We insert fence instructions to prevent cpu reordering. This ensures safe multi-threaded data access.",
      "compiler performance benchmark suite runs flamegraph profiles measuring cache miss rates branch mispredictions instruction level parallelism to locate bottlenecks in compiler execution. The benchmark runner measures execution time. We identify hot paths using performance profiling tools. This guides compiler performance optimization.",
      "compiler security hardening adds stack canaries address space layout randomization ASLR data execution prevention DEP checks to mitigate buffer overflow vulnerabilities in generated binaries. The security module instruments generated binary. We insert checks to detect buffer overflow attempts. This prevents code execution exploits.",
      "compiler error recovery system allows parser to recover from syntax errors using panic mode recovery or phrase level substitution to continue compiling subsequent source code declarations. The recovery system handles parser errors. We skip tokens to find synchronization point. This reports multiple errors in single compile run."
    ];

    for (let i = 0; i < 20; i++) {
      const text = paragraphWords[i];
      const id = insertMemory(text, 0.5, null, 'shared');
      const emb = await generateEmbedding(text);
      insertVector(id, emb);
    }

    // A. Query with 'general' intent (limit should be capped at 1500 tokens)
    const resGeneral = await getOptimizedContext('Random compiler chitchat query', 4000, null, null, 'shared', 'general');
    assert.ok(resGeneral.memories.length < 20, 'General intent should restrict number of memories retrieved due to 1500 token cap');

    // B. Query with 'debugging' intent (should use full 4000 token budget)
    const resDebug = await getOptimizedContext('Critical error compiler crash in database migration Spec', 4000, null, null, 'shared', 'debugging');
    assert.ok(resDebug.memories.length > resGeneral.memories.length, 'Debugging intent should allow more memories in budget');
  });

  await t.test('4. Cross-Namespace Semantic Deduplication', async () => {
    // Clean old data to avoid overlap
    db.exec('DELETE FROM memories; DELETE FROM memories_vec;');

    const text = 'Decision: Use TailwindCSS for component styling.';
    
    // Insert in shared namespace
    const id1 = insertMemory(text, 0.9, null, 'shared');
    const emb1 = await generateEmbedding(text);
    insertVector(id1, emb1);

    // Insert duplicate in agent namespace
    const id2 = insertMemory(text, 0.9, null, 'cursor-agent');
    const emb2 = await generateEmbedding(text);
    insertVector(id2, emb2);

    // Query optimized context for 'cursor-agent' namespace (looks at cursor-agent + shared)
    const result = await getOptimizedContext('Which framework to use for styling?', 4000, 'cursor-agent', null, 'cursor-agent');
    
    // Count matches
    const matchedCount = result.memories.filter(m => m.content.includes('TailwindCSS')).length;
    assert.equal(matchedCount, 1, 'Should filter out semantic duplicates across namespaces');
  });

  await t.test('5. Dense Prompt Formatting', async () => {
    db.exec('DELETE FROM memories; DELETE FROM memories_vec;');
    const text = 'Rule: Run lint check before commit.';
    const id = insertMemory(text, 0.9, null, 'shared');
    const emb = await generateEmbedding(text);
    insertVector(id, emb);

    const result = await getOptimizedContext('Should I lint?', 4000, null, null, 'shared');
    
    // Verify that the formatted context contains the dense representation
    assert.ok(result.context.includes(`#${id}: ${text}`), 'Prompt context should match compact format');
    assert.ok(!result.context.includes(`Memory #${id}`), 'Prompt context should not contain verbose metadata headers');
  });
});
