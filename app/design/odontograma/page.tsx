import type { Metadata } from 'next'
import { OdontogramaPlayground } from './OdontogramaPlayground'

export const metadata: Metadata = { title: 'Odontograma' }

export default function Page() {
  return <OdontogramaPlayground />
}
