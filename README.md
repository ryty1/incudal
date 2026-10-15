> **本项目基于官方 [qwer-xyz/incudal](https://github.com/qwer-xyz/incudal) 修改而来，并非官方版本。** ｜ 遇到问题请勿向官方提 issue。

> 改动清单见本文件末尾「附：与原版的差异」。
 
# Incudal 面板 · 部署与运维手册

> 面向单机自托管：Incus NAT-VPS 销售面板（app + PostgreSQL + Redis），
> 通过 nginx 对外，可选 Cloudflare 隧道回源。
> 本文档基于实际生产部署整理，包含**踩过的坑**。

---

## 一、环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| 系统 | Debian 12/13 (x86_64 / ARM64) | ARM64 已验证 |
| Docker | 24+ 与 docker compose v2 | 必须 |
| 内存 | ≥ 4 GB | app 编译时峰值较高 |
| 磁盘 | ≥ 20 GB | 镜像 + 数据库 + 备份 |
| Node | 不需要装 | 构建在容器内完成 |
| 公网 | 80/443 或 Cloudflare 隧道 | 见第五节 |

**端口规划（默认）**

```
3000    面板 app（只监听 127.0.0.1，不要暴露公网）
5432    PostgreSQL（容器内，不映射出来）
6379    Redis（容器内，不映射出来）
8443    节点 Agent 通信（由节点侧主动连面板，或面板连节点）
```

> ⚠️ **绝不要把 3000 / 5432 / 6379 绑到 0.0.0.0**。对外一律走 nginx。

---

## 二、目录结构

```
/home/docker/incudal/                 ← 项目根
├── docker-compose.yml
├── .env                              ← 配置（含密钥，600 权限，别提交 git）
├── .env.example                      ← 配置模板
├── server/                           ← 后端 (Fastify + Prisma)
│   ├── src/
│   │   ├── routes/                   ← 路由：hosts / instances / bot-bridge / backup …
│   │   ├── db/                       ← 数据访问层
│   │   ├── services/                 ← status-scheduler 等
│   │   ├── lib/                      ← 工具（notifier / bot-bridge-config …）
│   │   └── types/database.ts
│   ├── prisma/schema.prisma          ← 数据模型
│   ├── templates/install.sh          ← 节点一键安装脚本（对外分发）
│   └── certs/                        ← mTLS 客户端证书（运行时生成，别提交）
├── client/                           ← 前端 (Vue3 + Vite)
│   ├── src/views/admin/              ← 管理端页面
│   ├── src/locales/{zh-CN,zh-TW,en}.ts
│   └── public/sw.js                  ← Service Worker（改前端要升版本号）
└── agent/                            ← 节点侧 Agent
```

**数据目录（不在项目内）**

```
/srv/incudal-backups/                 备份文件（属主 1001:65533，权限 750）
/srv/incudal-backup.conf              备份配置（权限 640）
/usr/local/bin/incudal-backup.sh      备份脚本
/usr/local/bin/incudal-restore.sh     恢复脚本
/usr/local/bin/incudal-backup-trigger.sh  容器→宿主机触发器
```

---

## 三、首次部署

### 1. 拉取代码

```bash
mkdir -p /home/docker && cd /home/docker

# 方式一：SSH（需先在仓库 Settings → Deploy keys 加部署密钥，勾 Allow write access）
git clone git@github.com:ryty1/incudal.git incudal

# 方式二：HTTPS
# git clone https://github.com/ryty1/incudal.git incudal

cd incudal
```

> 服务器无法直连 GitHub 时，可本地克隆后打包上传：
> ```bash
> # 本地
> git clone git@github.com:ryty1/incudal.git
> tar czf incudal.tar.gz --exclude='.git' incudal
> scp incudal.tar.gz root@<服务器IP>:/home/docker/
> # 服务器
> cd /home/docker && tar xzf incudal.tar.gz && cd incudal
> ```

### 2. 准备配置

```bash
cp .env.example .env
chmod 600 .env
```

**必须填的项**（缺一不可）：

```ini
# ---- 数据库（DATABASE_URL 由 docker-compose 自动拼，不用写）----
POSTGRES_USER=incudal
POSTGRES_PASSWORD=<自己生成一个强密码>
POSTGRES_DB=incudal

# ---- Redis（REDIS_URL 同样自动拼）----
REDIS_PASSWORD=<自己生成一个强密码>

# ---- 安全 ----
JWT_SECRET=<openssl rand -hex 32>
COOKIE_SECRET=<openssl rand -hex 32>
ENCRYPTION_KEY=<openssl rand -hex 32>       # 加密面板里的敏感配置（bot token 等）
ADMIN_PASSWORD=<首次启动用它建管理员，之后在面板里改>

# ---- 站点 ----
SITE_URL=https://panel.example.com
FRONTEND_URL=https://panel.example.com
APP_PORT=3000
LOG_LEVEL=info
```

> `docker-compose.yml` 里已把 `POSTGRES_*` / `REDIS_PASSWORD` 拼成
> `DATABASE_URL`、`REDIS_URL` 传给容器，**`.env` 里不用重复写**。
> `ADMIN_PASSWORD` 在**首次启动**时用来创建管理员；生产环境不允许用默认值，
> 否则启动会直接报错 `ADMIN_PASSWORD must be configured to a non-default value in production`。

生成随机密钥：

```bash
openssl rand -hex 32
```

> ⚠️ `JWT_SECRET` 和 `ENCRYPTION_KEY` **一旦部署就不要改** —— 改了会让已加密的
> 配置（如 bot 桥接 token）解不开、所有用户登录态失效。
> ⚠️ `.env` 权限 600，**不要提交 git**。

### 3. 构建并启动

```bash
cd /home/docker/incudal

docker compose build app          # 首次约 3~8 分钟（看机器性能）
docker compose up -d              # 启动 app + db + redis

# 等待健康检查通过（app 启动约 10 秒）
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1:3000/api/health)
  [ "$code" = "200" ] && echo "OK health=200" && break
  sleep 3
done
```

### 4. 初始化数据库

```bash
# 建表 + 迁移（共 154 个迁移）
docker compose exec -T app sh -c 'cd /app/server && npx prisma migrate deploy'
```

> **没有 `prisma db seed`**（该项目不提供通用 seed）。
> 管理员账号由 app **首次启动时自动创建**，用的是 `.env` 里的 `ADMIN_PASSWORD`；
> 系统配置、语言包等也在启动时自动写入，无需手工灌数据。
>
> 可选脚本（按需，非必须）：
> ```bash
> docker compose exec -T app sh -c 'cd /app/server && pnpm seed:test-data'    # 测试数据
> docker compose exec -T app sh -c 'cd /app/server && pnpm reset:db'          # 重置数据库（危险）
> ```

### 5. 验证

```bash
curl -s http://127.0.0.1:3000/api/health        # → {"status":"ok",...}
docker compose ps                                # 三个容器都应 Up / healthy
docker compose logs app --tail 30                # 不应有 FastifyError
```

浏览器打开 `http://<服务器IP>:3000`（仅本机可访问时用 SSH 端口转发）：

```bash
ssh -L 3000:127.0.0.1:3000 root@<服务器IP>
# 然后本地浏览器开 http://127.0.0.1:3000
```

用 `.env` 里的 `ADMIN_EMAIL` / `ADMIN_PASSWORD` 登录，**登录后立刻改密码**。

---

## 四、对外暴露（nginx）

### 1. 系统 nginx 反代

`/etc/nginx/conf.d/incudal.conf`：

```nginx
server {
    listen 80;
    server_name panel.example.com;

    client_max_body_size 64m;      # 备份文件上传需要

    # Service Worker 不能缓存（否则前端改动永远不生效）
    location = /sw.js {
        proxy_pass http://127.0.0.1:3000;
        add_header Cache-Control "no-store, no-cache, must-revalidate" always;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        "upgrade";
        proxy_read_timeout 300s;       # 长任务（备份/导入）别被掐断
    }
}
```

```bash
nginx -t && systemctl reload nginx
```

### 2. Cloudflare 隧道（可选，无需公网 IP）

```bash
# 用 token 启动隧道（ingress 在 CF 控制台配置）
cloudflared tunnel --token <YOUR_TOKEN> run
```

CF 控制台把域名指向该隧道 → 回源到 `http://127.0.0.1:80`。

> ⚠️ CF 会把源站的 `max-age=0` 改写成 `max-age=14400`。
> 对 `/`、`/index.html`、`/sw.js` 要显式加 `no-store`（CF 不覆盖 no-store）。

---

## 五、日常运维

### 常用命令

```bash
cd /home/docker/incudal

docker compose ps                       # 状态
docker compose logs -f app              # 实时日志
docker compose restart app              # 重启后端
docker compose exec app sh              # 进容器
docker compose exec -T db psql -U incudal -d incudal   # 进数据库
```

### ⚠️ 重新部署的正确姿势（重要）

`docker compose up -d app` 有时会因**残留容器占名**失败：

```
Error response from daemon: Conflict. The container name "/xxx_incudal-app-1"
is already in use by container "yyy"
```

**正确顺序**：

```bash
cd /home/docker/incudal
docker compose stop app
docker compose rm -f app          # 先清掉，避免撞名
docker compose build app
docker compose up -d app
```

### 改了后端代码后

⚠️ **最容易踩的坑**：容器里的 `/app/server/src` 是**镜像构建时**的旧代码。
只 `docker compose cp` 了 tsconfig 而没 cp 新源码 → 编译出来的是旧代码 → **假阳性编译**。

```bash
# 改完源码后：
docker compose cp server/src/routes/xxx.ts app:/app/server/src/routes/xxx.ts
docker compose exec -T app sh -c 'cd /app/server && npx tsc --noEmit'   # 先验类型
docker compose build app && docker compose stop app && docker compose rm -f app && docker compose up -d app
```

### 改了前端代码后

```bash
# 1) 升 Service Worker 缓存版本，否则用户浏览器一直吃旧 JS
#    client/public/sw.js:  const CACHE_NAME = 'incudal-cache-v7'  → v8
sed -i 's/incudal-cache-v[0-9]*/incudal-cache-v8/' client/public/sw.js

# 2) 重新构建部署
docker compose build app && docker compose stop app && docker compose rm -f app && docker compose up -d app
```

**确认新代码真进去了**（别只看构建日志）：

```bash
# 用「字符串」验（函数名会被压缩改名，字符串不会）
docker compose exec -T app sh -c 'grep -rl "你的新文案" /app/client/dist/assets/*.js | wc -l'
```

**用户侧还需要**：F12 → Application → Service Workers → **Unregister** → Ctrl+Shift+R。
（只按 Ctrl+Shift+R 没用，SW 的 Cache Storage 不受强刷影响。）

---

## 六、数据库备份 / 恢复

### 架构

```
容器内 UI  ──写 /backup/.request──▶  宿主机 systemd path unit（inotify，秒级）
                                        │
                                        ▼
                              /usr/local/bin/incudal-backup-trigger.sh
                                        │
                                        ▼
                              真正的备份脚本（宿主机执行）
                                        │
容器内 UI  ◀──读 /backup/.result───  写结果
```

> 容器**不挂 docker socket**（否则等于把宿主机 root 交出去）。

### 权限与路径

```bash
mkdir -p /srv/incudal-backups
chown 1001:65533 /srv/incudal-backups    # 容器内 app 的 uid
chmod 750 /srv/incudal-backups
chmod 640 /srv/incudal-backup.conf
```

`docker-compose.yml` 里挂载：

```yaml
services:
  app:
    volumes:
      - /srv/incudal-backups:/backup
      - /srv/incudal-backup.conf:/backup/incudal-backup.conf
```

### 手工备份 / 恢复

```bash
# 备份
/usr/local/bin/incudal-backup.sh

# 看有哪些备份
/usr/local/bin/incudal-restore.sh list

# 恢复（overwrite=清空还原 / merge=只补缺失）
/usr/local/bin/incudal-restore.sh /srv/incudal-backups/incudal-YYYYMMDD-HHMMSS.dump --mode merge --yes
/usr/local/bin/incudal-restore.sh /srv/incudal-backups/incudal-YYYYMMDD-HHMMSS.dump --mode overwrite --yes
```

> 恢复脚本会在导入前自动存一份 `pre-import-*.sql.gz` 快照，可回退。
> 备份格式是 `pg_dump -Fc`（`.dump`，已内置压缩），脚本同时兼容旧的 `.sql.gz`。

### 定时任务

```bash
crontab -l
# CRON_TZ=Asia/Shanghai
# 10 3 * * * /usr/local/bin/incudal-backup.sh
```

改 crontab **绝不要**用管道 `{ ...; crontab -l | grep -v X; } | crontab -` ——
中间出错会丢其它无关条目。先落临时文件确认，再灌回。

### ⚠️ `pg_restore` 在容器里，不在宿主机

```bash
# 宿主机没有 pg_restore，必须走容器
docker compose exec -T db pg_restore --list /dev/stdin < "$FILE"
```

---

## 七、常见问题

### Q: 改了代码但页面上没变化

```
1. 前端产物没更新 → 重新 build + 换容器
2. Service Worker 缓存 → 升 CACHE_NAME 版本号，并让用户 Unregister
3. nginx / CF 缓存 → /、/index.html、/sw.js 加 no-store
4. 构建其实失败了 → 查 docker compose build 输出里的 error TS
   注意：构建失败时容器会继续跑【旧镜像】，health 仍是 200 → 别被迷惑
```

### Q: 面板打不开，health 返回 000

```
看日志：docker compose logs app --tail 50
常见：FST_ERR_DUPLICATED_ROUTE（路由重复注册）→ 用脚本改代码时切片边界错了
      FastifyError → 启动期抛异常
```

### Q: 接口返回 502 / 前端 Failed to fetch

```
长任务（备份、导入）走了 nginx/CF，超过 ~60 秒被切断。
正确做法：改成【下发 + 轮询】
  POST /xxx        → 立即返回 {started:true}
  GET  /xxx/status → {done:false} / {done:true, ok, detail}
  前端每 3 秒轮询，最多等 20 分钟
```

### Q: 备份删除失败：`Body cannot be empty when content-type is set to 'application/json'`

```
DELETE 请求无 body 时不要带 Content-Type: application/json。
前端封装里改成「只在有 body 时才设 Content-Type」。
```

### Q: 数据库连不上

```bash
docker compose ps                        # db 是否 healthy
docker compose logs db --tail 30
docker compose exec -T db pg_isready -U incudal
```

### Q: 备份文件莫名其妙少了

```
清理逻辑已加保护：无论保留天数怎么设，【至少保留最近 3 份、绝不删最新】。
每次删除都会写日志，可在「运维 → 数据 → 备份日志」查。
```

---

## 八、安全清单

```
✓ .env 权限 600，不进 git
✓ 3000/5432/6379 只监听 127.0.0.1
✓ 容器不挂 docker socket
✓ 备份目录属主 1001:65533、权限 750（不要用 chmod 777）
✓ JWT_SECRET / ENCRYPTION_KEY 部署后不再改
✓ 管理员首次登录后改密码，开 2FA
✓ 面板内所有密钥（bot token / SMTP 密码 / GitHub token）视为机密，不要贴到聊天里
✓ 定期检查：docker compose logs app | grep -iE "error|fail"
```

---

## 九、升级流程

```bash
cd /home/docker/incudal

# 1) 先备份！
/usr/local/bin/incudal-backup.sh

# 2) 留一份旧代码
cp -a /home/docker/incudal /home/docker/incudal.bak-$(date +%Y%m%d)

# 3) 用新包覆盖源码（不要覆盖 .env）
#    解压新包 → 把 server/ client/ agent/ 覆盖过来

# 4) 升 Service Worker 版本（如果前端有改动）
sed -i 's/incudal-cache-v[0-9]*/incudal-cache-v8/' client/public/sw.js

# 5) 构建 + 换容器
docker compose build app
docker compose stop app && docker compose rm -f app && docker compose up -d app

# 6) 跑数据库迁移
docker compose exec -T app sh -c 'cd /app/server && npx prisma migrate deploy'

# 7) 验证
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/api/health
docker compose logs app --tail 30
```

**回滚**：把 `incudal.bak-*` 覆盖回来 → 重新 build + up → 必要时用恢复脚本导回备份。

---

## 十、目录速查（运维常用）

| 用途 | 路径 |
|---|---|
| 项目根 | `/home/docker/incudal` |
| 配置 | `/home/docker/incudal/.env` |
| nginx | `/etc/nginx/conf.d/incudal.conf` |
| 备份文件 | `/srv/incudal-backups/` |
| 备份配置 | `/srv/incudal-backup.conf` |
| 备份脚本 | `/usr/local/bin/incudal-backup.sh` |
| 恢复脚本 | `/usr/local/bin/incudal-restore.sh` |
| 触发器 | `/usr/local/bin/incudal-backup-trigger.sh` |
| 节点安装脚本（对外） | `https://<域名>/api/hosts/install.sh/<token>` |
| 面板管理入口 | `/admin/settings`（运维 → 数据） |

---

*本文档随部署实践更新；遇到新坑请补进对应小节。*
