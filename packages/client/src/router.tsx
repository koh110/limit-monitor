import { createBrowserRouter } from 'react-router-dom'
import { Dashboard, dashboardLoader } from './routes/dashboard'

export const router = createBrowserRouter([
  {
    path: '/',
    loader: dashboardLoader,
    Component: Dashboard
  }
])
