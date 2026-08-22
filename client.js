/** Browser half for DSH's lazy-CJS module loader. */
window.__ModuleLoader__.load({
  id: 'dsh-language-tutor',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    var Button = primitives.Button
    var MarkdownText = primitives.MarkdownText
    var Pill = primitives.Pill

    function h(type, props) {
      var children = Array.prototype.slice.call(arguments, 2)
      return React.createElement.apply(React, [type, props].concat(children))
    }

    var CARD = {
      border: '1px solid var(--dsw-border-color, rgba(128,128,128,.24))',
      borderRadius: 10,
      padding: '10px 12px',
      margin: '4px 0',
      background: 'var(--dsw-alias-bg-subtle, var(--dsw-surface-color, transparent))',
      color: 'var(--dsw-text-color, inherit)',
      fontSize: 13,
      lineHeight: 1.55,
    }
    var TITLE = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
      fontWeight: 650,
      marginBottom: 8,
    }
    var MUTED = { color: 'var(--dsw-alias-fg-muted, currentColor)', opacity: .72 }
    var SECTION = { marginTop: 10, fontSize: 11, fontWeight: 650, letterSpacing: '.03em', opacity: .65 }
    var ROW = {
      padding: '5px 0',
      borderTop: '1px solid var(--dsw-border-color, rgba(128,128,128,.14))',
    }
    var BUTTONS = { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }

    function ReviewCard(props) {
      var card = props.node.data
      if (card.mode === 'check') {
        var items = Array.isArray(card.items) ? card.items : []
        return h('section', { style: CARD, className: 'dsh-language-tutor-review' },
          h('div', { style: TITLE }, h('span', null, '✏️ Writing check'), h(Pill, null, card.learning)),
          items.map(function (item, index) {
            return h('div', { key: index, style: ROW },
              h('div', null,
                h('span', { style: { color: 'var(--dsw-alias-fg-danger, #c0392b)', textDecoration: 'line-through' } }, item.wrong),
                h('span', { style: { margin: '0 7px', opacity: .5 } }, '→'),
                h('span', { style: { color: 'var(--dsw-alias-fg-success, #16865b)', fontWeight: 600 } }, item.right)),
              item.reason ? h('div', { style: MUTED }, item.reason) : null)
          }),
          card.rephrase ? h('div', { style: Object.assign({}, ROW, { marginTop: 2 }) },
            h('div', { style: SECTION }, 'MORE NATURAL'),
            h(MarkdownText, { text: card.rephrase })) : null)
      }
      var tutor = card.tutor || { sentence: '', words: [], grammar: [] }
      return h('section', { style: CARD, className: 'dsh-language-tutor-tutor' },
        h('div', { style: TITLE },
          h('span', null, '✏️ Writing tutor'),
          h('span', null,
            card.addedCards > 0 ? h(Pill, { active: true }, '+' + card.addedCards + ' cards') : null,
            h(Pill, null, card.learning))),
        h(MarkdownText, { text: tutor.sentence || '' }),
        tutor.words && tutor.words.length
          ? h('div', null,
              h('div', { style: SECTION }, 'VOCABULARY'),
              tutor.words.map(function (item, index) {
                return h('div', { key: index, style: ROW },
                  h('strong', null, item.word),
                  h('div', { style: MUTED }, item.note))
              }))
          : null,
        tutor.grammar && tutor.grammar.length
          ? h('div', null,
              h('div', { style: SECTION }, 'GRAMMAR'),
              tutor.grammar.map(function (item, index) {
                return h('div', { key: index, style: ROW },
                  h('strong', null, item.structure),
                  h('div', { style: MUTED }, item.note))
              }))
          : null)
    }

    function TranslationCard(props) {
      var card = props.node.data
      var segments = Array.isArray(card.segments) ? card.segments : null
      if (card.status === 'loading') {
        return h('section', { style: CARD, className: 'dsh-language-tutor-translation' },
          h('div', { style: TITLE }, h('span', null, '🌐 Translating…'), h(Pill, null, card.native)),
          h('div', { style: MUTED }, 'Preparing a bilingual version of this response.'))
      }
      if (card.status === 'error') {
        return h('section', { style: CARD, className: 'dsh-language-tutor-translation' },
          h('div', { style: TITLE }, h('span', null, '🌐 Translation failed'), h(Pill, null, card.native)),
          h('div', { style: { color: 'var(--dsw-alias-fg-danger, #c0392b)' } }, card.error || 'The auxiliary model request failed.'))
      }
      return h('section', { style: CARD, className: 'dsh-language-tutor-translation' },
        h('div', { style: TITLE }, h('span', null, '🌐 Bilingual translation'), h(Pill, null, card.native)),
        segments
          ? segments.map(function (segment, index) {
              if (segment.kind === 'pair') {
                return h('div', { key: index, style: index === 0 ? null : { marginTop: 14 } },
                  h(MarkdownText, { text: segment.source }),
                  h('div', {
                    style: {
                      borderLeft: '3px solid var(--dsw-alias-border-accent, #5b7cfa)',
                      paddingLeft: 10,
                      marginTop: 6,
                      opacity: .82,
                    },
                  }, h(MarkdownText, { text: segment.translation })))
              }
              if (segment.kind === 'code') return h(MarkdownText, { key: index, text: segment.text })
              return h('div', { key: index, style: MUTED }, 'Code block omitted · ' + segment.lines + ' lines')
            })
          : h(MarkdownText, { text: card.text || '' }))
    }

    function FlashcardView(props) {
      var card = props.node.data
      var busyState = React.useState(false)
      var errorState = React.useState('')
      function execute(line) {
        if (busyState[0] || typeof props.runCommand !== 'function') return
        busyState[1](true)
        errorState[1]('')
        Promise.resolve(props.runCommand(line)).then(function (result) {
          if (result && result.ok === false) errorState[1](result.error && result.error.message || 'Command failed')
        }).catch(function (error) {
          errorState[1](error && error.message || String(error))
        }).finally(function () { busyState[1](false) })
      }
      if (card.stage === 'empty') {
        return h('section', { style: CARD },
          h('div', { style: TITLE }, h('span', null, '🗂 Flashcards')),
          h('div', { style: MUTED }, card.message || 'No cards due.'))
      }
      if (card.stage === 'rated') {
        return h('section', { style: Object.assign({}, CARD, { padding: '7px 12px' }) },
          h('span', { style: { color: 'var(--dsw-alias-fg-success, #16865b)', fontWeight: 600 } }, '✓ ' + (card.word || 'Card rated')),
          h('span', { style: Object.assign({}, MUTED, { marginLeft: 8 }) }, card.remaining + ' remaining'))
      }
      return h('section', { style: CARD, className: 'dsh-language-tutor-flashcard' },
        h('div', { style: TITLE },
          h('span', null, card.stage === 'question' ? '🗂 Flashcard' : '🗂 Answer'),
          h(Pill, null, card.remaining + ' left')),
        h('div', { style: { fontSize: 20, fontWeight: 650, padding: '8px 0' } }, card.word || ''),
        card.stage === 'answer' ? h('div', { style: Object.assign({}, ROW, { fontSize: 14 }) }, card.note || '') : null,
        card.stage === 'question'
          ? h('div', { style: BUTTONS },
              h(Button, {
                variant: 'outline', disabled: busyState[0],
                onClick: function () { execute('/flashcards show ' + card.reviewId) },
              }, 'Show answer'))
          : h('div', { style: BUTTONS },
              ['again', 'hard', 'good', 'easy'].map(function (rating) {
                return h(Button, {
                  key: rating,
                  variant: rating === 'good' ? 'primary' : 'outline',
                  disabled: busyState[0],
                  onClick: function () { execute('/flashcards rate ' + card.reviewId + ' ' + rating) },
                }, rating.charAt(0).toUpperCase() + rating.slice(1))
              })),
        errorState[0] ? h('div', { style: { color: 'var(--dsw-alias-fg-danger, #c0392b)', marginTop: 6 } }, errorState[0]) : null)
    }

    function TutorCardView(props) {
      var kind = props.node && props.node.data && props.node.data.kind
      if (kind === 'review') return h(ReviewCard, props)
      if (kind === 'translation') return h(TranslationCard, props)
      if (kind === 'flashcard') return h(FlashcardView, props)
      return null
    }

    function TranslateAction(props) {
      var busy = React.useState(false)
      return h(Button, {
        variant: 'toolbar',
        size: 'sm',
        title: 'Translate this response',
        'aria-label': 'Translate this response',
        disabled: busy[0],
        onClick: function () {
          if (busy[0] || typeof props.translateMessage !== 'function') return
          busy[1](true)
          Promise.resolve(props.translateMessage(props.messageId)).catch(function () {}).finally(function () { busy[1](false) })
        },
      }, busy[0] ? '…' : '🌐')
    }

    var definition = {
      kind: 'language-tutor-card',
      target: 'chat',
      match: function (event) {
        if (event.type !== 'language-tutor/card') return null
        return { id: String(event.data.cardId), role: event.data.role }
      },
      start: function (_context, match) { return match.event.data.card },
      update: function (_context, match) { return match.event.data.card },
      buildViewNode: function (context) {
        if (context.start === undefined || context.state === undefined) return null
        return {
          key: context.key,
          kind: 'language-tutor-card',
          id: context.id,
          target: 'chat',
          anchorSeq: context.start.event.seq,
          location: context.start.location,
          visibility: 'visible',
          data: context.state,
        }
      },
    }

    exports.name = 'dsh-language-tutor/client'
    exports.inject = ['slots', 'conversationEvents', 'remote', 'remote.commands']
    exports.apply = function (ctx) {
      var slots = ctx.get('slots')
      var events = ctx.get('conversationEvents')
      var remote = ctx.get('remote')
      if (slots === undefined || events === undefined) return
      events.register(definition)
      slots.inject('conversation.chat.node', function () {
        return slots.register({
          name: 'conversation.chat.node',
          key: 'language-tutor-card',
          inject: function (sessionId) {
            return {
              runCommand: function (line) {
                if (!remote || !remote.commands) return Promise.reject(new Error('Commands remote is unavailable'))
                return remote.commands.execute(sessionId, line, [])
              },
            }
          },
        }, TutorCardView)
      })
      slots.inject('conversation.chat.assistant-actions', function () {
        return slots.register({
          name: 'conversation.chat.assistant-actions',
          id: 'language-tutor-translate',
          order: 30,
          inject: function (sessionId) {
            return {
              translateMessage: function (messageId) {
                if (!remote || !remote.commands) return Promise.reject(new Error('Commands remote is unavailable'))
                return remote.commands.execute(sessionId, '/translate ' + messageId, [])
              },
            }
          },
        }, TranslateAction)
      })
    }

    return module.exports
  },
})
