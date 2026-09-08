import { Children, isValidElement, type ReactNode } from 'react'
import { Links, Meta, Scripts, createRoutesStub } from 'react-router'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vite-plus/test'
import App, { HydrateFallback, Layout, meta } from './root'

afterEach(() => {
  cleanup()
})

/** 描画せずに Layout の element tree を走査して component の有無だけを見る */
function componentTypes(node: ReactNode): unknown[] {
  if (!isValidElement(node)) {
    return []
  }
  const { children } = node.props as { children?: ReactNode }
  return [
    node.type,
    ...Children.toArray(children).flatMap((child) => {
      return componentTypes(child)
    })
  ]
}

test('Layout は Meta / Links / Scripts を document へ配置する', () => {
  // Scripts が欠けると prerender した index.html から hydration script が
  // 消えて SPA が起動しなくなるため、配線として固定する。
  // <html> を含む tree は container へ mount できないので、Layout を直接
  // 呼び出して返り値の element tree だけを検査する。
  const types = componentTypes(Layout({ children: null }))
  expect(types).toContain(Meta)
  expect(types).toContain(Links)
  expect(types).toContain(Scripts)
})

test('meta は title と viewport を返す', () => {
  const tags = meta({} as Parameters<typeof meta>[0])
  expect(tags).toContainEqual({ title: 'Limit Monitor' })
  expect(tags).toContainEqual({
    name: 'viewport',
    content: 'width=device-width, initial-scale=1'
  })
})

test('clientLoader 解決前は root の HydrateFallback を描画する', () => {
  // root が HydrateFallback を持たないと、React Router が開発者向けの
  // console.log だけを行う既定 fallback を本番 index.html へ埋め込む。
  const Stub = createRoutesStub([
    {
      path: '/',
      Component: App,
      HydrateFallback,
      children: [
        {
          index: true,
          loader: () => {
            return new Promise(() => {})
          },
          Component: () => {
            return <p>loaded</p>
          }
        }
      ]
    }
  ])

  render(<Stub />)

  expect(screen.getByRole('heading', { name: 'Limit Monitor' })).toBeTruthy()
  expect(screen.getByText('観測値を読み込んでいます')).toBeTruthy()
  expect(screen.queryByText('loaded')).toBeNull()
})
