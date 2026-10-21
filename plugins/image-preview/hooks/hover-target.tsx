// The client module of the pointer targets: a chip that posts `isOver` as the pointer comes onto
// it, moves on it and leaves it, so the hooks module opens and closes that image's preview; and
// `isClicked`, so the hooks module opens the image in the system's viewer.
import type { ClientModule } from 'claude-code'

/** `label`, the chip's text; none (or no props), an unpainted region over a row the engine draws. */
type Props = { label?: string } | null

const REPEAT_MS = 50

const Chip: ClientModule<Props, { isOver: boolean; isPressed?: boolean }> = (props, surface) => {
  const label = props?.label
  surface.onPointer(event => {
    // A click is the left button let go over the chip it went down on.
    if (event.type === 'down') {
      if (event.button === 'left') surface.setState({ isOver: true, isPressed: true })
      return
    }
    if (event.type === 'up') {
      // A region not laid out yet (0 by 0) says nothing of where the pointer is.
      const isInside = surface.columns === 0 || (event.x >= 0 && event.y >= 0 && event.x < surface.columns && event.y < surface.rows)
      if (surface.state?.isPressed && isInside) surface.post({ isOver: true, isClicked: true })
      surface.setState({ isOver: isInside })
      return
    }
    // A move over the chip says so again: a card hidden while the pointer stayed comes back.
    const isOver = event.type !== 'leave'
    surface.post({ isOver })
    if (isOver !== (surface.state?.isOver ?? false)) surface.setState({ isOver, isPressed: surface.state?.isPressed })
    // Going straight from one chip to the next, the leave and the enter post in one frame, and the
    // later replaces the other: the enter says so again a frame on.
    if (event.type === 'enter') {
      const stop = surface.every(REPEAT_MS, () => {
        stop()
        if (surface.state?.isOver) surface.post({ isOver: true })
      })
    }
  })
  const { Box, Text } = surface.elements
  if (label === undefined) return <Box />
  return <Text color="claude" inverse={surface.state?.isOver === true}>{label}</Text>
}

export default Chip
