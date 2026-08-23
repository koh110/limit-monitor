import 'server-only'

// Dashboard(server side)から見た Limit Hub の base URL
export const HUB_BASE_URL = process.env.HUB_BASE_URL ?? 'http://127.0.0.1:8787'
