'use client'

import { useEffect, useState } from 'react'
import { Button } from './Button'

type Tema = 'claro' | 'escuro'

/**
 * Alterna claro/escuro. O tema inicial é aplicado por um script inline em
 * `app/layout.tsx`, antes da primeira pintura — por isso aqui só lemos o que
 * já está no DOM, sem causar flash.
 */
export function AlternarTema() {
  const [tema, setTema] = useState<Tema | null>(null)

  useEffect(() => {
    setTema(document.documentElement.classList.contains('dark') ? 'escuro' : 'claro')
  }, [])

  function alternar(): void {
    const proximo: Tema = tema === 'escuro' ? 'claro' : 'escuro'
    document.documentElement.classList.toggle('dark', proximo === 'escuro')
    try {
      localStorage.setItem('dent-tema', proximo)
    } catch {
      // Modo privado sem storage: o tema vale só nesta navegação.
    }
    setTema(proximo)
  }

  return (
    <Button
      tamanho="sm"
      variante="fantasma"
      onClick={alternar}
      aria-label={tema === 'escuro' ? 'Mudar para tema claro' : 'Mudar para tema escuro'}
    >
      {/* Antes da hidratação o tema é desconhecido: reserva o espaço sem texto errado. */}
      {tema === null ? ' ' : tema === 'escuro' ? 'Claro' : 'Escuro'}
    </Button>
  )
}
