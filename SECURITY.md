# Security Policy

## 前提

limit-monitor は個人利用を前提とした private network 内のシステムであり、
Limit Hub を public Internet へ公開しない。

## データ最小化

Hub へ送信してよいのは正規化された数値情報のみ:

- provider(`codex` / `claude`)
- 非機密の accountAlias / sourceId(人間が設定する別名)
- bucket ID / label、使用率・残量、window 長、reset 時刻、観測時刻、limit 到達状態

送信禁止:

- Codex/Claude の認証ファイル(`~/.codex/auth.json` 等)
- OAuth token、API key、session cookie
- プロンプト・レスポンス・transcript
- repository 名、path、branch、cwd、session ID
- メールアドレス、ベンダーの生 account ID

契約 schema(`packages/shared/src/contracts.ts`)は accountAlias / sourceId に
`@` を含む文字列を拒否し、生アカウント ID の混入を防ぐ。

## 認証

- Collector ごとに個別の Bearer token を発行する(`npm run tokens -w hub -- issue`)
- Hub は token の SHA-256 hash のみを保存し、平文を保存しない
- token 認証成功時に、保存する`sourceId`はtokenに紐付く値へHub側で正規化する。payloadの`sourceId`は表示用入力として受け取るが、認証・保存の基準にはしない。
- 失効(revoke)と再発行(reissue)が可能
- 認証失敗は 401

## Network

- Router で Hub port(8787)を WAN へ port forward しない
- Hub は自宅 LAN と Cloudflare Tunnel private route 経由のみで到達させる
- 公開 DNS route を作らない
- OS firewall で許可元とportを絞る

## Secret の取り扱い

- token・秘密情報をリポジトリへ commit しない(`.env` は `.gitignore` 済み)
- 長期運用では systemd credentials(`LoadCredential`)または 1Password CLI を利用する
- ログに token、vendor response 全文、認証情報を出力しない

## 報告

脆弱性を発見した場合は public issue を立てず、リポジトリ管理者へ直接連絡すること。
