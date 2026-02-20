# Ralph Loop for Memory System

## What is This?

A Ralph Loop script that will continuously iterate with Claude Code until the memory system is fully functional.

## What is a Ralph Loop?

A Ralph Loop is a simple bash script pattern that keeps running a command until it succeeds. Named after Ralph Wiggum from The Simpsons, it embodies persistence: keep trying until you get it right.

**Original concept:** 5 lines of bash by Geoffrey Huntley
```bash
while :; do
    cat PROMPT.md | claude-code
done
```

## How to Use

### Option 1: Run the Ralph Loop
```bash
./ralph-loop-memory.sh
```

The script will:
1. Check what tasks remain incomplete
2. Run Claude with the prompt
3. Rebuild if needed
4. Test changes
5. Loop until everything works
6. Exit automatically when complete

### Option 2: Run manually (for debugging)
```bash
# Run Claude with the prompt
cat PROMPT.md | claude

# Rebuild
npm run build

# Test
npm run memory search lucy "Cricket"
```

## What It Does

The loop continues until ALL tasks in `docs/MEMORY_TASKS.md` are marked [x] complete.

**Max iterations:** 50 (safety limit)

## Progress Tracking

- Current iteration: Stored in `.ralph-checkpoint`
- Full log: `.ralph-log.txt`
- Tasks: `docs/MEMORY_TASKS.md`

## Stopping the Loop

Press `Ctrl+C` to stop at any time. Progress is saved.

## Resume

Just run the script again - it will continue from where it left off.

## Monitoring

Watch the logs in real-time:
```bash
tail -f .ralph-log.txt
```

## Expected Timeline

With the Ralph Loop approach, this should take 3-10 iterations depending on the complexity of bugs found.

---

## Sources

- [Ralph Loop: 修复AI代理的健忘症](https://m.blog.csdn.net/shebao3333/article/details/157315507)
- [从 ReAct 到 Ralph Loop：AI Agent 的持续迭代范式](https://developer.aliyun.com/article/1709232)
- [GitHub: frankbria/ralph-claude-code](https://github.com/frankbria/ralph-claude-code)
