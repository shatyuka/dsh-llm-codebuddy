import { describe, expect, it } from 'vitest'
import { adjustContextLabels, adjustMessages, adjustPromptText } from '../src/prompt.js'

/** The identity sentence as the harness assembles it. */
const IDENTITY = 'You are an AI agent powered by DeepSeek Harness.'

describe('adjustPromptText', () => {
  it('adds the colon the identity check does not expect', () => {
    expect(adjustPromptText(`${IDENTITY}\n\nBody.`))
      .toBe('You are an AI agent powered by: DeepSeek Harness.\n\nBody.')
  })

  it('keeps every product name', () => {
    // The agent needs the name to know it may inspect or extend the checkout.
    expect(adjustPromptText(IDENTITY)).toContain('DeepSeek Harness')
  })

  it('is idempotent, so a second pass changes nothing', () => {
    const once = adjustPromptText(IDENTITY)
    expect(adjustPromptText(once)).toBe(once)
  })

  it('adjusts the Web-surface tail', () => {
    const text = 'When the user refers to "this page" without naming another target, they mean this GUI. '
    expect(adjustPromptText(text))
      .toBe('When the user refers to "this page" without naming another target, they mean this Web GUI. ')
  })

  it('leaves the identity alone when it is not the opening', () => {
    // Only an opening reaches the check, so an inner occurrence is the model's
    // own text and must survive.
    const text = `Intro. ${IDENTITY}`
    expect(adjustPromptText(text)).toBe(text)
  })

  it('leaves the system-prompt paragraphs the service accepts', () => {
    const source = 'The runtime context names the DeepSeek Harness implementation checkout. '
      + 'Use this checkout only to inspect or extend DSH itself.'
    const web = 'You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names.'
    expect(adjustPromptText(source)).toBe(source)
    expect(adjustPromptText(web)).toBe(web)
  })

  it('rewords the path sentence the service blocks', () => {
    const text = 'Tokens prefixed with @ are paths the user explicitly referenced. '
      + 'Relative paths resolve from the workspace root; absolute paths identify files or directories on the host.'
    expect(adjustPromptText(text)).toBe('Tokens prefixed with @ are paths the user explicitly referenced. '
      + 'Relative paths resolve against the workspace root; absolute paths identify files or directories on the host.')
  })

  it('is idempotent across every rewrite', () => {
    const text = `${IDENTITY}\n\nWhen asked "this page" without naming another target, they mean this GUI.\n\n`
      + 'Relative paths resolve from the workspace root.'
    const once = adjustPromptText(text)
    expect(adjustPromptText(once)).toBe(once)
  })
})

describe('adjustContextLabels', () => {
  it('reworks both runtime-context labels', () => {
    expect(adjustContextLabels('Current DeepSeek Harness implementation checkout: "/opt/x".'))
      .toBe('The DeepSeek Harness implementation checkout in effect: "/opt/x".')
    expect(adjustContextLabels('Current DeepSeek Harness Web GUI URL: "http://127.0.0.1:1".'))
      .toBe('The DeepSeek Harness Web GUI URL in effect: "http://127.0.0.1:1".')
  })

  it('is idempotent', () => {
    const once = adjustContextLabels('Current DeepSeek Harness Web GUI URL: "http://127.0.0.1:1".')
    expect(adjustContextLabels(once)).toBe(once)
  })

  it('keeps every product name', () => {
    expect(adjustContextLabels('Current DeepSeek Harness implementation checkout: "/opt/x".'))
      .toContain('DeepSeek Harness')
  })

  it('leaves an unrelated line alone', () => {
    const text = 'Current DSH file policy: workspace-write.'
    expect(adjustContextLabels(text)).toBe(text)
  })
})

describe('adjustMessages', () => {
  const SYSTEM = { role: 'system', content: [{ type: 'text', text: IDENTITY }] }
  const typed = { role: 'user', content: [{ type: 'text', text: IDENTITY }], source: { kind: 'user' } }
  const snapshot = {
    role: 'user',
    content: [{ type: 'text', text: 'Current runtime context.\n\nCurrent DeepSeek Harness Web GUI URL: "http://127.0.0.1:1".' }],
    source: { kind: 'runtime-context' },
  }

  it('adjusts a system message', () => {
    const [out] = adjustMessages([SYSTEM])
    expect((out?.content as { text: string }[])[0]?.text).toBe('You are an AI agent powered by: DeepSeek Harness.')
  })

  it('adjusts an assistant message', () => {
    const assistant = { role: 'assistant', content: [{ type: 'text', text: IDENTITY }] }
    const [out] = adjustMessages([assistant])
    expect((out?.content as { text: string }[])[0]?.text).toBe('You are an AI agent powered by: DeepSeek Harness.')
  })

  it('leaves typed input alone', () => {
    expect(adjustMessages([typed])[0]).toBe(typed)
  })

  it('leaves a tool result alone', () => {
    const tool = { role: 'tool', content: [{ type: 'text', text: IDENTITY }] }
    expect(adjustMessages([tool])[0]).toBe(tool)
  })

  it('adjusts the labels of a runtime-context snapshot', () => {
    const [out] = adjustMessages([snapshot])
    expect((out?.content as { text: string }[])[0]?.text)
      .toContain('The DeepSeek Harness Web GUI URL in effect:')
  })

  it('adjusts a system message that travels in the list', () => {
    // The loop may place a system message among the messages rather than beside
    // them; both paths take the same wording.
    const inList = { role: 'system', content: [{ type: 'text', text: IDENTITY }] }
    const [out] = adjustMessages([inList])
    expect((out?.content as { text: string }[])[0]?.text).toBe('You are an AI agent powered by: DeepSeek Harness.')
  })

  it('adjusts a plain-string content', () => {
    const plain = { role: 'assistant', content: IDENTITY }
    expect(adjustMessages([plain])[0]?.content).toBe('You are an AI agent powered by: DeepSeek Harness.')
  })

  it('keeps a message object untouched when nothing changed', () => {
    // Identity, not equality: an unchanged message must not be copied.
    const plain = { role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }
    expect(adjustMessages([plain])[0]).toBe(plain)
  })

  it('leaves image parts in place', () => {
    const withImage = {
      role: 'system',
      content: [{ type: 'text', text: IDENTITY }, { type: 'image_url', image_url: { url: 'x' } }],
    }
    const [out] = adjustMessages([withImage])
    const blocks = out?.content as { type: string, text?: string }[]
    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.text).toBe('You are an AI agent powered by: DeepSeek Harness.')
    expect(blocks[1]?.type).toBe('image_url')
  })
})
