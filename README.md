# Anchor

Anchor adds reactive behavior to standard HTML through a small set of attributes and elements. It requires no build step, compiler, or virtual DOM. Pages are written as ordinary HTML and enhanced by a single script.

```html
<script src="https://cdn.jsdelivr.net/gh/iamkave/Anchor@1.0.0/interpreter.js"></script>

<form @NameForm>
  <input @NameInput type="text" placeholder="Your name">
  <input type="submit" value="Greet">
</form>

<format await="NameForm:submit">
  <p>Hello, <r value="@NameInput"></r>!</p>
</format>
```

## Contents

- [Features](#features)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Markup reference](#markup-reference)
- [JavaScript API](#javascript-api)
- [Examples](#examples)
- [Security](#security)
- [Documentation](#documentation)

## Features

- **Reactive data.** Publish data with `Anchor.expose` and every part of the page that depends on it updates when it changes.
- **Loops and conditions.** Render lists with `<repeat>`, including sorting, paging, and empty states, and show or hide markup with `<if>` and `<else>`.
- **Two-way binding.** Keep form controls and data synchronized with `bind`, or capture a whole form with `pushto`.
- **Declarative requests.** Load data with `<fetch>`, with loading and error state exposed automatically.
- **Components.** Define reusable templates once with `<wraps>` and use them as HTML tags.
- **Restricted function calls.** Markup can call only the functions that a script has explicitly registered.

## Installation

Add the script to the page. The `<head>` is conventional, but any position works because Anchor processes the document after it has finished parsing.

```html
<script src="https://cdn.jsdelivr.net/gh/iamkave/Anchor@1.0.0/interpreter.js"></script>
```

Use an exact version in the URL so that a page does not change unexpectedly.

### Requirements

Anchor must be served over `http://` or `https://`. Opening a page directly from the file system (`file://`) is not supported. Any local development server is sufficient, for example:

```sh
npx serve
```

## Quick start

Publish data from a script, then refer to it in markup with the `$` prefix.

```html
<ul>
  <repeat as="item" in="$Items">
    <li>[item.name]</li>
    <else><li>No items.</li></else>
  </repeat>
</ul>

<script>
  let { Items } = Anchor.expose({ Items: [] });

  Items.push({ name: "Milk" }); // the list updates automatically
</script>
```

`Anchor.expose()` returns the reactive versions of the values it receives. Assign the returned values, as above, and modify those. Changes made to the original objects are not tracked.

## Markup reference

### Reference syntax

| Prefix | Refers to |
| --- | --- |
| `@Name` | A named element. Adding `@Name` as a bare attribute registers the element as `Anchor.elements.Name`. |
| `$name` | An exposed value, including nested paths such as `$user.address.city`. |
| `[name]` | A loop variable inside `<repeat>`, or a literal value. |

### Elements and attributes

| Directive | Purpose | Main attributes |
| --- | --- | --- |
| `<repeat>` | Render a block for each entry of an array or object. | `as`, `in`, `index`, `sort`, `limit`, `await` |
| `<if>` / `<else>` | Show or hide markup. | `test`, `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `has`, `not`, `await` |
| `<call>` | Invoke a registered function. | `fn`, `params`, `await`, `return`, `pend` |
| `bind` | Two-way binding on `<input>`, `<textarea>`, and `<select>`. | `bind="$path"` |
| `pushto` | Collect a whole form into an object on submit. | `<form pushto="$path">` |
| `<fetch>` | Perform an HTTP request. | `@id`, `url`, `pushto`, `method`, `body`, `parse`, `await` |
| `<format>` | Reveal a block of markup when an event fires. | `await` |
| `<wraps>` | Define reusable components. | `<wrap tag="name">` |
| Text styling | Apply common text styles. | `<up>`, `<low>`, `<cap>`, `<fo name="">`, `<h c="">` |

### Events

Directives that accept `await` take a value in the form `"Element:event"`, where `Element` is an `@id` and `event` is any DOM event. For example, `await="NameForm:submit"` runs when the form is submitted. `<call>` and `<fetch>` dispatch an `invoke` event when they complete, and `<fetch>` dispatches `error` on failure, so other directives can wait on `"Name:invoke"` or `"Name:error"`.

### Loop variables

Every iteration of `<repeat>` provides a `loop` object.

| Field | Meaning |
| --- | --- |
| `loop.number` | 1-based position |
| `loop.index` | 0-based position |
| `loop.first` | `true` on the first item |
| `loop.last` | `true` on the last item |
| `loop.length` | Total number of items |

### Fetch state

`<fetch pushto="$weather">` exposes two additional values automatically: `$weatherLoading` (boolean) and `$weatherError` (string or `null`). A failed request does not overwrite the last successful response.

## JavaScript API

| Member | Description |
| --- | --- |
| `Anchor.expose(vars)` | Publishes data as reactive state and returns the reactive versions. |
| `Anchor.get(name)` | Returns the current value of an exposed root. |
| `Anchor.set(name, value)` | Replaces an exposed value. Also accepts an updater function, `prev => next`. |
| `Anchor.exposeFunctions(fns)` | Registers the functions that `<call>` is permitted to invoke. |
| `Anchor.elements` | Maps each registered `@id` to its element. |
| `Anchor.ready` | A promise that resolves when Anchor has finished initializing. |
| `Anchor.mount(el, target, position)` | Inserts an element into the document. `target` may be an `Element`, an `"@id"` string, or a CSS selector. `position` is `append` (default), `prepend`, `before`, `after`, or `replace`. |
| `Anchor.createWrap(tag, id, innerHTML, attrs)` | Creates a component usage element in JavaScript. |
| `Anchor.loop(source, render, reactive)` | Builds a list from a template function and returns a container element for `Anchor.mount`. |

Use `Anchor.ready` rather than `DOMContentLoaded` before calling `Anchor.mount`, `Anchor.createWrap`, or `Anchor.loop`:

```js
Anchor.ready.then(() => {
  Anchor.mount(Anchor.createWrap("note-card", null, "Hello", { tone: "info" }), "@Board");
});
```

## Examples

The `anchor-examples` folder contains five short pages, each with its complete source shown below the live demo.

| Example | Demonstrates |
| --- | --- |
| `01-greeting.html` | Identifiers and `<format>` with `await` |
| `02-task-list.html` | `Anchor.expose`, `<repeat>`, `<call>`, and `Anchor.exposeFunctions` |
| `03-live-profile.html` | `bind`, `<if>` with comparators, and `<repeat>` over an object |
| `04-remote-data.html` | `<fetch>`, `sort`, `limit`, and `Anchor.set` |
| `05-components.html` | `<wraps>`, `Anchor.ready`, `Anchor.createWrap`, and `Anchor.mount` |

Serve the folder over `http://` and open `index.html`.

## Security

- Values interpolated with `[item.name]` are set as text, never as HTML, so markup in the data is displayed literally.
- Access to `__proto__`, `constructor`, and `prototype` is blocked for both reading and writing.
- `<call>` can invoke only functions registered with `Anchor.exposeFunctions()`. Functions in global scope are not accessible.
- URL attributes (`href`, `src`) and event-handler attributes (`onclick` and similar) are not sanitized. Do not bind them to data that is not fully trusted.
- The string returned by an `Anchor.loop` render function is assigned with `innerHTML`. Escape any user-provided text before including it.

## Documentation

The complete reference is in `anchor-docs.html`, which covers every directive, attribute, and API member in detail.
