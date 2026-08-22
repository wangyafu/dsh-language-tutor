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
    var Input = primitives.Input
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

    function flashcardDueText(item) {
      if (item.state === 'new') return '新卡'
      if (item.state === 'due') return '已到期'
      if (!item.due) return '已安排'
      try {
        return '下次 ' + new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(item.due))
      } catch (_error) {
        return '已安排'
      }
    }

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

    function LanguageSettingsView(props) {
      var card = props.node.data
      var busyState = React.useState(false)
      var errorState = React.useState('')
      var learningState = React.useState(card.learning || 'en')
      var nativeState = React.useState(card.native || 'zh-CN')
      var routeText = card.route && card.route.provider && card.route.model
        ? card.route.provider + '/' + card.route.model
        : ''
      var modelState = React.useState(routeText)

      React.useEffect(function () { learningState[1](card.learning || 'en') }, [card.learning])
      React.useEffect(function () { nativeState[1](card.native || 'zh-CN') }, [card.native])
      React.useEffect(function () { modelState[1](routeText) }, [routeText])

      function execute(key, value) {
        if (busyState[0] || typeof props.runCommand !== 'function') return
        busyState[1](true)
        errorState[1]('')
        var line = '/lang update ' + card.settingsId + ' ' + key + ' ' + encodeURIComponent(value)
        Promise.resolve(props.runCommand(line)).then(function (result) {
          if (result && result.ok === false) errorState[1](result.error && result.error.message || 'Command failed')
        }).catch(function (error) {
          errorState[1](error && error.message || String(error))
        }).finally(function () { busyState[1](false) })
      }

      function choiceRow(label, detail, values, current, key) {
        return h('div', { style: ROW },
          h('strong', null, label),
          h('div', { style: MUTED }, detail),
          h('div', { style: Object.assign({}, BUTTONS, { marginTop: 6 }) },
            values.map(function (value) {
              return h(Pill, {
                key: value,
                active: current === value,
                disabled: busyState[0],
                onClick: function () { if (current !== value) execute(key, value) },
              }, value)
            })))
      }

      function inputRow(label, detail, valueState, key, placeholder) {
        return h('div', { style: ROW },
          h('strong', null, label),
          h('div', { style: MUTED }, detail),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 6, marginTop: 7 } },
            h(Input, {
              value: valueState[0],
              placeholder: placeholder,
              disabled: busyState[0],
              onChange: function (event) { valueState[1](event.target.value) },
              onKeyDown: function (event) {
                if (event.key === 'Enter' && valueState[0].trim()) execute(key, valueState[0].trim())
              },
              style: { width: '100%' },
            }),
            h(Button, {
              variant: 'outline', size: 'sm', disabled: busyState[0] || !valueState[0].trim(),
              onClick: function () { execute(key, valueState[0].trim()) },
            }, '保存')))
      }

      return h('section', { style: CARD, className: 'dsh-language-tutor-settings' },
        h('div', { style: TITLE },
          h('span', null, '🌐 语言学习设置'),
          h(Pill, null, card.learning + ' → ' + card.native)),
        card.message ? h('div', {
          style: { color: 'var(--dsw-alias-fg-success, #16865b)', marginBottom: 6 },
        }, card.message) : null,
        choiceRow('写作检查', '检查学习语言中的错误；context 会参考最近对话。', ['off', 'on', 'context'], card.check, 'check'),
        choiceRow('母语教学', '用母语提问时，给出学习语言表达和词汇。', ['off', 'on'], card.tutor ? 'on' : 'off', 'tutor'),
        choiceRow('自动翻译', '自动为较长的助手回答生成双语卡。', ['off', 'on'], card.auto ? 'on' : 'off', 'auto'),
        choiceRow('翻译上下文', '翻译时带上最近一小段对话。', ['off', 'on'], card.context ? 'on' : 'off', 'context'),
        inputRow('学习语言', '例如 en、fr、ja。', learningState, 'learning', 'en'),
        inputRow('母语', '用于讲解和翻译，例如 zh-CN。', nativeState, 'native', 'zh-CN'),
        h('div', { style: ROW },
          h('strong', null, '辅助模型'),
          h('div', { style: MUTED }, routeText ? '当前使用 ' + routeText : '当前跟随会话模型。'),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto auto', gap: 6, marginTop: 7 } },
            h(Input, {
              value: modelState[0],
              placeholder: 'provider/model',
              disabled: busyState[0],
              onChange: function (event) { modelState[1](event.target.value) },
              onKeyDown: function (event) {
                if (event.key === 'Enter' && modelState[0].trim()) execute('model', modelState[0].trim())
              },
              style: { width: '100%' },
            }),
            h(Button, {
              variant: 'outline', size: 'sm', disabled: busyState[0] || !modelState[0].trim(),
              onClick: function () { execute('model', modelState[0].trim()) },
            }, '保存'),
            h(Button, {
              variant: 'outline', size: 'sm', disabled: busyState[0] || !routeText,
              onClick: function () { execute('model', 'default') },
            }, '跟随会话'))),
        errorState[0] ? h('div', { style: { color: 'var(--dsw-alias-fg-danger, #c0392b)', marginTop: 6 } }, errorState[0]) : null)
    }

    function FlashcardView(props) {
      var card = props.node.data
      var busyState = React.useState(false)
      var errorState = React.useState('')
      var editIdState = React.useState('')
      var editWordState = React.useState('')
      var editNoteState = React.useState('')
      var deleteIdState = React.useState('')
      function execute(line, onSuccess) {
        if (busyState[0] || typeof props.runCommand !== 'function') return
        busyState[1](true)
        errorState[1]('')
        Promise.resolve(props.runCommand(line)).then(function (result) {
          if (result && result.ok === false) errorState[1](result.error && result.error.message || 'Command failed')
          else if (typeof onSuccess === 'function') onSuccess()
        }).catch(function (error) {
          errorState[1](error && error.message || String(error))
        }).finally(function () { busyState[1](false) })
      }
      if (card.stage === 'library') {
        var items = Array.isArray(card.items) ? card.items : []
        var page = card.page || 1
        var pageCount = card.pageCount || 1
        return h('section', { style: CARD, className: 'dsh-language-tutor-flashcard-library' },
          h('div', { style: TITLE },
            h('span', null, '🗂 词卡库'),
            h(Pill, null, (card.total || 0) + ' 张')),
          card.message ? h('div', {
            style: { color: 'var(--dsw-alias-fg-success, #16865b)', marginBottom: 6 },
          }, card.message) : null,
          items.length === 0 ? h('div', { style: MUTED }, '还没有词卡。可用 /flashcards add 单词 :: 释义 添加。') : null,
          items.map(function (item) {
            var editing = editIdState[0] === item.id
            var confirmingDelete = deleteIdState[0] === item.id
            return h('div', { key: item.id, style: ROW },
              h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
                h('strong', { style: { fontSize: 14 } }, item.word),
                h('span', { style: { display: 'flex', gap: 5 } },
                  h(Pill, null, item.source === 'tutor' ? '自动' : '手动'),
                  h(Pill, { active: item.state === 'due' }, flashcardDueText(item)))),
              editing
                ? h('div', { style: { display: 'grid', gap: 7, marginTop: 7 } },
                    h(Input, {
                      value: editWordState[0],
                      placeholder: '单词或短语',
                      disabled: busyState[0],
                      onChange: function (event) { editWordState[1](event.target.value) },
                      style: { width: '100%' },
                    }),
                    h(Input, {
                      value: editNoteState[0],
                      placeholder: '释义或笔记',
                      disabled: busyState[0],
                      onChange: function (event) { editNoteState[1](event.target.value) },
                      style: { width: '100%' },
                    }),
                    h('div', { style: { display: 'flex', gap: 6 } },
                      h(Button, {
                        variant: 'primary', size: 'sm', disabled: busyState[0] || !editWordState[0].trim() || !editNoteState[0].trim(),
                        onClick: function () {
                          execute('/flashcards update ' + card.reviewId + ' ' + item.id + ' ' + page + ' '
                            + encodeURIComponent(editWordState[0].trim()) + ' ' + encodeURIComponent(editNoteState[0].trim()), function () {
                              editIdState[1]('')
                            })
                        },
                      }, '保存'),
                      h(Button, {
                        variant: 'outline', size: 'sm', disabled: busyState[0],
                        onClick: function () { editIdState[1]('') },
                      }, '取消')))
                : h('div', null,
                    h('div', { style: Object.assign({}, MUTED, { marginTop: 2 }) }, item.note),
                    h('div', { style: { display: 'flex', gap: 6, marginTop: 6 } },
                      h(Button, {
                        variant: 'outline', size: 'sm', disabled: busyState[0],
                        onClick: function () {
                          editIdState[1](item.id)
                          editWordState[1](item.word)
                          editNoteState[1](item.note)
                          deleteIdState[1]('')
                        },
                      }, '编辑'),
                      confirmingDelete
                        ? h(React.Fragment, null,
                            h(Button, {
                              variant: 'primary', size: 'sm', disabled: busyState[0],
                              onClick: function () {
                                execute('/flashcards delete ' + card.reviewId + ' ' + item.id + ' ' + page, function () {
                                  deleteIdState[1]('')
                                })
                              },
                            }, '确认删除'),
                            h(Button, {
                              variant: 'outline', size: 'sm', disabled: busyState[0],
                              onClick: function () { deleteIdState[1]('') },
                            }, '取消'))
                        : h(Button, {
                            variant: 'outline', size: 'sm', disabled: busyState[0],
                            onClick: function () { deleteIdState[1](item.id); editIdState[1]('') },
                          }, '删除'))))
          }),
          pageCount > 1 ? h('div', { style: Object.assign({}, BUTTONS, { alignItems: 'center' }) },
            h(Button, {
              variant: 'outline', size: 'sm', disabled: busyState[0] || page <= 1,
              onClick: function () { execute('/flashcards library ' + card.reviewId + ' ' + (page - 1)) },
            }, '上一页'),
            h('span', { style: MUTED }, page + ' / ' + pageCount),
            h(Button, {
              variant: 'outline', size: 'sm', disabled: busyState[0] || page >= pageCount,
              onClick: function () { execute('/flashcards library ' + card.reviewId + ' ' + (page + 1)) },
            }, '下一页')) : null,
          errorState[0] ? h('div', { style: { color: 'var(--dsw-alias-fg-danger, #c0392b)', marginTop: 6 } }, errorState[0]) : null)
      }
      if (card.stage === 'settings') {
        function settingRow(label, detail, key, value, step, minimum) {
          return h('div', { style: ROW },
            h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
              h('div', null, h('strong', null, label), h('div', { style: MUTED }, detail)),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                h(Button, {
                  variant: 'outline', size: 'sm', disabled: busyState[0] || value <= minimum,
                  onClick: function () { execute('/flashcards settings ' + card.reviewId + ' ' + key + ' ' + Math.max(minimum, value - step)) },
                }, '−'),
                h('strong', { style: { minWidth: 28, textAlign: 'center' } }, String(value)),
                h(Button, {
                  variant: 'outline', size: 'sm', disabled: busyState[0] || value >= 200,
                  onClick: function () { execute('/flashcards settings ' + card.reviewId + ' ' + key + ' ' + Math.min(200, value + step)) },
                }, '+'))))
        }
        return h('section', { style: CARD, className: 'dsh-language-tutor-flashcard-settings' },
          h('div', { style: TITLE }, h('span', null, '🗂 复习设置')),
          card.message ? h('div', {
            style: { color: 'var(--dsw-alias-fg-success, #16865b)', marginBottom: 6 },
          }, card.message) : null,
          settingRow('每轮上限', '一次复习最多发出的卡片数', 'sessionLimit', card.sessionLimit || 20, 5, 1),
          settingRow('每日新卡', '每天最多引入的新卡数', 'newPerDay', typeof card.newPerDay === 'number' ? card.newPerDay : 10, 1, 0),
          h('div', { style: Object.assign({}, MUTED, { marginTop: 8 }) }, '修改后从下一轮 /flashcards 开始生效。'),
          errorState[0] ? h('div', { style: { color: 'var(--dsw-alias-fg-danger, #c0392b)', marginTop: 6 } }, errorState[0]) : null)
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
      if (kind === 'settings') return h(LanguageSettingsView, props)
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
