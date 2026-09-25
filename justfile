# SuperCode 一键命令（docs/development-process.md §7）
# 任何新增检查项先进 verify 再进流程——闭环成本必须保持最低。

default:
    @just --list

# 一键验证：前端构建 + fmt 检查 + clippy 严格 + 全部测试（DoD 硬标准）
# 前端构建是前置条件：supercode-desktop 的 build.rs 要求 frontendDist（dist/）存在
verify:
    pnpm --filter @supercode/desktop build
    cargo fmt --check
    cargo clippy --all-targets -- -D warnings
    cargo test

# 自动修复格式与部分 clippy 问题
fix:
    cargo fmt
    cargo clippy --all-targets --fix --allow-dirty

# 冒烟验收：需本机 opencode 已安装并完成认证（对应 roadmap 当前 Phase 剧本）
smoke:
    cargo build
    ./target/debug/supercode detect
    ./target/debug/supercode run '回复 ok 两个字母即可' --cwd /tmp/supercode-smoke < /dev/null
