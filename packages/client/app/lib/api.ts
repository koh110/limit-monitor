import type * as schema from 'shared/src/schema'

type Prettify<T> = { [K in keyof T]: T[K] } & {}
type HttpMethod = 'get' | 'post' | 'put' | 'delete' | 'options' | 'head' | 'patch' | 'trace'
type Present<T> = Exclude<T, undefined | never>
type OperationAt<T extends keyof schema.paths, K extends HttpMethod> = Present<schema.paths[T][K]>
type SupportedMethod<T extends keyof schema.paths> = {
  [K in HttpMethod]: Present<schema.paths[T][K]> extends never ? never : K
}[HttpMethod]

type StatusNumKeys<R> = Extract<keyof R, number>
type JsonBody<R> = R extends { content: infer C }
  ? C extends { 'application/json': infer J }
    ? J
    : C extends { 'application/problem+json': infer P }
      ? P
      : string
  : string

type TypedResponse<R> = {
  [S in StatusNumKeys<R>]: { status: S; body: JsonBody<R[S]> }
}[StatusNumKeys<R>]

export type { HttpMethod }
export type ClientResponse<R> = TypedResponse<R>

type OptionsFor<T extends keyof schema.paths, K extends SupportedMethod<T>> = {
  path: T
  method: K
  parameters: OperationAt<T, K> extends { parameters: infer P } ? P : never
} & (OperationAt<T, K> extends {
  requestBody: { content: { 'application/json': infer Q } }
}
  ? { requestBody: Q }
  : { requestBody?: never })

type ResponseFor<T extends keyof schema.paths, K extends SupportedMethod<T>> =
  OperationAt<T, K> extends { responses: infer R } ? R : never

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function buildRequestUrl(baseUrl: string, pathTemplate: string, parameters: unknown): string {
  const replacements: Array<[token: string, value: string]> = []
  const path = isRecord(parameters) && isRecord(parameters.path) ? parameters.path : undefined
  const templatedPath = pathTemplate.replace(/\{([^}]+)\}/g, (match, name: string) => {
    if (!path || !(name in path)) return match
    const token = `__path_parameter_${replacements.length}__`
    replacements.push([token, encodeURIComponent(String(path[name])).replaceAll('.', '%2E')])
    return token
  })
  const requestUrl = new URL(templatedPath, baseUrl).toString()
  return replacements.reduce((current, [token, value]) => current.replace(token, value), requestUrl)
}

type RequestInitWithoutOperationFields = Omit<RequestInit, 'body' | 'method'> & {
  body?: never
  method?: never
}

export async function client<T extends keyof schema.paths, K extends SupportedMethod<T>>(
  baseUrl: string,
  options: OptionsFor<T, K>,
  init?: RequestInitWithoutOperationFields
): Promise<Prettify<ClientResponse<ResponseFor<T, K>>>> {
  const requestInit: RequestInit = {
    ...init,
    method: options.method
  }

  if ('requestBody' in options && options.requestBody !== undefined) {
    requestInit.body = JSON.stringify(options.requestBody)
    const headers = new Headers(init?.headers)
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    requestInit.headers = headers
  }

  const requestUrl = buildRequestUrl(
    baseUrl,
    options.path,
    'parameters' in options ? options.parameters : undefined
  )
  const response = await fetch(requestUrl, requestInit)
  const text = await response.text()
  const contentType = response.headers.get('Content-Type')?.toLowerCase() ?? ''
  let body: unknown = text
  if (text.length > 0 && contentType.includes('json')) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }

  return { status: response.status, body } as Prettify<ClientResponse<ResponseFor<T, K>>>
}

export function createFetchOptions<T extends keyof schema.paths, K extends SupportedMethod<T>>(
  options: OptionsFor<T, K>
): OptionsFor<T, K> {
  return options
}

type APIResponse = { status: number; body: unknown }

export type APIResult<
  ClientFn extends (...args: any[]) => unknown,
  SuccessStatus extends number,
  Response extends APIResponse = Awaited<ReturnType<ClientFn>> extends APIResponse
    ? Awaited<ReturnType<ClientFn>>
    : never
> = SuccessStatus extends Response['status']
  ?
      | {
          ok: true
          status: SuccessStatus
          body: Extract<Response, { status: SuccessStatus }>['body']
        }
      | {
          ok: false
          status: Exclude<Response['status'], SuccessStatus>
          body: Exclude<Response, { status: SuccessStatus }>['body']
        }
  : never

export function toAPIResult<
  ClientFn extends (...args: any[]) => unknown,
  SuccessStatus extends number,
  Response extends APIResponse = Awaited<ReturnType<ClientFn>> extends APIResponse
    ? Awaited<ReturnType<ClientFn>>
    : never
>(
  response: Response,
  successStatus: SuccessStatus & (SuccessStatus extends Response['status'] ? unknown : never)
): APIResult<ClientFn, SuccessStatus, Response> {
  const typedResponse = response as Awaited<ReturnType<ClientFn>> & APIResponse
  return (
    typedResponse.status === successStatus
      ? { ok: true, status: successStatus, body: typedResponse.body }
      : { ok: false, status: typedResponse.status, body: typedResponse.body }
  ) as APIResult<ClientFn, SuccessStatus, Response>
}
