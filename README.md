# tranfu-skills CLI

公司 Claude/Codex skill 库 CLI。

## 装

```
npm i -g tranfu-skills
```

## 验证装好

```
tfs --version
# → 0.1.0-slice1.0
```

拿到 command not found?
- fnm/nvm 用户: `which fnm && fnm use default`
- 仍然有问题: 检查 `~/.npm-global/bin` 在 PATH

## 搜公司 skill

```
tfs search auth
tfs search 认证 --json
tfs search auth --top 10
```
