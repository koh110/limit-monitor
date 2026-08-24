// Dashboard(browser)から見た Limit Hub の base URL。
// Vite の static build に焼き込まれるため、build 前に設定すること。
export const HUB_BASE_URL = import.meta.env.VITE_HUB_BASE_URL ?? 'http://127.0.0.1:8787'
