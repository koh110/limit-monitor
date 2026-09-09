type Options = {
  label?: string
  body: string
  meta?: Record<string, unknown>
}

type ErrorOptions = Options & {
  error?: unknown
}

// journald で扱いやすい構造化(JSON)ログ。token 等の秘密は出力しない
export const logger = {
  log: (options: Options) => {
    console.log(JSON.stringify({ ...options, level: 'INFO' }))
  },
  error: (options: ErrorOptions) => {
    console.error(
      JSON.stringify({
        ...options,
        error: options.error instanceof Error ? options.error.message : options.error,
        level: 'ERROR'
      })
    )
  }
} as const
