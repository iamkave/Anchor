const Anchor = {
    _data: Object.create(null),
    _subs: Object.create(null), // root name -> Set<fn> of render callbacks
    _fns: Object.create(null), // name -> function, populated only via exposeFunctions()
    // proxy -> root key, populated only for TOP-LEVEL values stored directly
    // in _data (see expose()). Nested property access re-wraps a fresh proxy
    // every read (see _reactive's get trap) so this deliberately can't
    // resolve those -- only whatever Anchor.expose() itself handed back.
    // Lets JS-side helpers (Anchor.loop) take the actual reactive reference
    // and still find their way to Anchor.watch(key, ...) without the
    // caller needing to also pass the key as a string.
    _rootOf: new WeakMap(),

    // Wraps objects/arrays in a Proxy so mutations (including nested ones,
    // e.g. GroceryList.push(...) or user.name = "x") notify subscribers
    // of the top-level root automatically, no manual expose() needed.
    _reactive(value, root) {
        if (value === null || typeof value !== "object") return value;
        if (value.__isAnchorReactive) return value;

        return new Proxy(value, {
            get(target, key, receiver) {
                if (key === "__isAnchorReactive") return true;
                const val = Reflect.get(target, key, receiver);
                // Bind to the PROXY (receiver), not the raw target: mutating
                // methods like push/splice/pop internally assign properties
                // (e.g. this[length] = x), and those assignments must go
                // through the proxy to hit the set trap below and notify.
                // Binding to target would silently bypass reactivity.
                if (typeof val === "function") return val.bind(receiver);
                if (val !== null && typeof val === "object") {
                    return Anchor._reactive(val, root);
                }
                return val;
            },
            set(target, key, val) {
                const ok = Reflect.set(target, key, val);
                Anchor._notify(root);
                return ok;
            },
            deleteProperty(target, key) {
                const ok = Reflect.deleteProperty(target, key);
                Anchor._notify(root);
                return ok;
            }
        });
    },

    _pendingRoots: new Set(),
    _flushScheduled: false,

    // Batches same-tick notifications (e.g. array.push does an index write
    // AND a length write) into a single render per root per microtask.
    _notify(root) {
        Anchor._pendingRoots.add(root);
        if (Anchor._flushScheduled) return;
        Anchor._flushScheduled = true;
        queueMicrotask(() => {
            Anchor._flushScheduled = false;
            const roots = [...Anchor._pendingRoots];
            Anchor._pendingRoots.clear();
            roots.forEach(r => {
                if (Anchor._subs[r]) Anchor._subs[r].forEach(fn => fn());
            });
        });
    },

    // Registers a render callback to re-run whenever `root` changes.
    watch(root, fn) {
        if (!Anchor._subs[root]) Anchor._subs[root] = new Set();
        Anchor._subs[root].add(fn);
    },

    // Returns the reactive versions of what was exposed. Mutations only
    // trigger re-renders when made through the reactive reference, so
    // rebind your local variable to it:
    //   let { GroceryList } = Anchor.expose({ GroceryList: [] });
    //   GroceryList.push(...)   // now auto-triggers watchers
    expose(vars) {
        if (vars == null || typeof vars !== "object") {
            console.error(`Anchor.expose() expects an object, got: ${vars}`);
            return {};
        }
        const reactiveVars = {};
        for (const key of Object.keys(vars)) {
            if (key === "expose" || key === "_data" || key === "_subs" || key === "watch" || key === "get" || key === "set") {
                console.error(`Anchor.expose(): "${key}" is reserved and was ignored.`);
                continue;
            }
            Anchor._data[key] = Anchor._reactive(vars[key], key);
            Anchor._notify(key); // in case this is a re-expose of an already-watched root
            // Only objects/arrays are ever wrapped by _reactive -- a primitive
            // comes back as itself, and WeakMap can't (and doesn't need to)
            // hold a primitive key.
            if (Anchor._data[key] !== null && typeof Anchor._data[key] === "object") {
                Anchor._rootOf.set(Anchor._data[key], key);
            }
            reactiveVars[key] = Anchor._data[key];
        }
        return reactiveVars;
    },

    // Anchor.get(name) -- plain JS-side read of an exposed value, no
    // $/@/[] syntax. Just Anchor._data[name], with the same missing-root
    // error every other directive already gives instead of a silent
    // `undefined` that's easy to mistake for "it's actually null".
    get(name) {
        if (!Object.prototype.hasOwnProperty.call(Anchor._data, name)) {
            console.error(`Anchor.get(): "${name}" was not found. Did you forget to call Anchor.expose({ ${name} })?`);
            return undefined;
        }
        return Anchor._data[name];
    },

    // Anchor.set(name, value) / Anchor.set(name, prev => next) -- plain
    // JS-side write, replacing the old Anchor._data.pageSize--; Anchor._notify("pageSize")
    // two-step. The updater form reads the CURRENT value at call time, so
    // Anchor.set("pageSize", n => n - 1) is safe to call from more than one
    // place without a stale closure racing another one.
    // Mirrors expose()'s object handling: an object/array value gets
    // rewrapped reactive and registered in _rootOf, same as if it had been
    // exposed fresh -- so Anchor.loop(..., true) still resolves it later.
    set(name, value) {
        if (!Object.prototype.hasOwnProperty.call(Anchor._data, name)) {
            console.error(`Anchor.set(): "${name}" was not found. Did you forget to call Anchor.expose({ ${name} })?`);
            return;
        }
        const next = typeof value === "function" ? value(Anchor._data[name]) : value;
        Anchor._data[name] = Anchor._reactive(next, name);
        if (Anchor._data[name] !== null && typeof Anchor._data[name] === "object") {
            Anchor._rootOf.set(Anchor._data[name], name);
        }
        Anchor._notify(name);
    },

    // Whitelists functions that <call fn="..."> is allowed to invoke.
    // <call> never reaches into window/global scope -- only names
    // registered here are callable from markup, e.g.:
    //   Anchor.exposeFunctions({ doThing });
    //   <call fn="doThing" params="[...]">
    exposeFunctions(fns) {
        if (fns == null || typeof fns !== "object") {
            console.error(`Anchor.exposeFunctions() expects an object, got: ${fns}`);
            return;
        }
        for (const key of Object.keys(fns)) {
            if (typeof fns[key] !== "function") {
                console.error(`Anchor.exposeFunctions(): "${key}" is not a function and was ignored.`);
                continue;
            }
            Anchor._fns[key] = fns[key];
        }
    }
};

// Anchor.ready -- resolves once Anchor's own setup is fully done: the
// case-recovery self-fetch has settled, Anchor.mount/createWrap/loop are
// assigned, and the initial pass over the document has run. DOMContentLoaded
// alone is NOT enough to safely call Anchor.mount/createWrap/loop -- Anchor's
// own DOMContentLoaded handler does an internal `await fetch(location.href)`
// before it gets to any of that, and a second, separate DOMContentLoaded
// listener runs to completion before that fetch has any chance to resolve
// (same-tick listeners don't wait on each other's internal awaits). Anchor.ready
// exists at the top level, the instant this script loads, specifically so code
// can attach to it regardless of script order:
//
//   Anchor.ready.then(() => {
//       Anchor.mount(Anchor.loop(GroceryList, item => `<li>${item.name}</li>`, true), "@List");
//   });
let _resolveReady;
Anchor.ready = new Promise(resolve => { _resolveReady = resolve; });

document.addEventListener("DOMContentLoaded", async () => {
    // ------------------------------------------------------------------
    // Case-preserving identifiers
    //
    // By the time the browser hands us a parsed DOM, attribute names are
    // already lowercased (HTML parsing is case-insensitive for attribute
    // names -- this is a parser rule, not something Anchor can opt out of).
    // So <input @GroceryName> and <input @groceryname> are indistinguishable
    // once DOMContentLoaded fires; el.attributes[0].name is "@groceryname"
    // either way, and outerHTML re-serializes from that already-lowercased
    // state, so it can't help either.
    //
    // The only place the original casing still exists is the raw response
    // bytes of the page itself. So Anchor re-fetches its own document,
    // before doing anything else, and regexes the ORIGINAL-CASE @id and
    // :id tokens out of that text. Everything downstream still finds
    // elements the old way (via the lowercased DOM attribute), but reports
    // and stores each one under its original-case name.
    //
    // This is why Anchor requires being served over http(s): fetching
    // location.href from a file:// page is blocked by the browser's CORS
    // policy, the same restriction that keeps any fetch-based dev tool
    // (React included) off the file:// protocol.
    let restoreCase = (lowercased) => lowercased; // identity fallback if the fetch fails
    try {
        const html = await fetch(location.href).then(r => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.text();
        });

        // Matches @Foo / :Foo as they appear in an opening tag's attribute
        // list: preceded by whitespace or a quote, and followed by
        // whitespace, "=", or the tag's closing angle bracket. This avoids
        // matching @/  : inside attribute VALUES (e.g. url="...@2x...").
        const idPattern = /(?<=[\s"'])([@:])([A-Za-z_][\w-]*)(?=[\s=>/])/g;
        const caseMap = Object.create(null); // lowercased -> original, per sigil
        caseMap["@"] = Object.create(null);
        caseMap[":"] = Object.create(null);

        let match;
        while ((match = idPattern.exec(html))) {
            const [, sigil, name] = match;
            const lower = name.toLowerCase();
            const existing = caseMap[sigil][lower];
            if (existing !== undefined && existing !== name) {
                console.error(`Anchor: "${sigil}${existing}" and "${sigil}${name}" both refer to the same identifier once lowercased by the browser. Rename one of them.`);
                continue;
            }
            caseMap[sigil][lower] = name;
        }

        restoreCase = (lowercased, sigil = "@") => caseMap[sigil][lowercased] ?? lowercased;
    } catch (err) {
        // Anchor still works with lowercase-only identifiers if this fails
        // (e.g. the page truly is opened as a file, or the server 404s on
        // its own URL for some reason) -- camelCase ids just won't survive.
        console.error(`Anchor: couldn't re-fetch this page to recover original-case identifiers (${err.message}). @ids and :ids will be treated as lowercase. Anchor must be served over http(s), not opened as a file.`);
    }

    const elements = {};
    const wraps = {};
    // lowercased runtime-synthesized @id -> its intended original case (see renderWrapUsages/Step 2 below)
    const runtimeIdCase = Object.create(null);

    // Same object reference the interpreter populates internally —
    // exposing it here (not a copy) means it fills in live as @id
    // elements are registered below, no separate sync step needed.
    Anchor.elements = elements;

    const foreignId = /^[\$@\[\]][A-Za-z]/
    const camel = str => str.replace(/[-_\s](.)/g, (_, c) => c.toUpperCase());

    // Returns [root itself (if it matches), ...root's matching descendants].
    // Every directive pass is written against this instead of a bare
    // document.querySelectorAll(...) so it can be re-run scoped to just a
    // freshly-inserted subtree (see processRoot / the MutationObserver
    // below) without re-touching the rest of the page.
    function scoped(root, selector) {
        const out = [];
        if (root.nodeType === Node.ELEMENT_NODE && root.matches(selector)) out.push(root);
        if (typeof root.querySelectorAll === "function") out.push(...root.querySelectorAll(selector));
        return out;
    }

    wraps.render = function (wrapId, referenceElement) {
        const { template, content, attrs } = wraps[wrapId];
        const el = template.cloneNode(true);

        // {get.content} -> the usage's innerHTML (as before).
        // {get.anythingElse} -> the value of that attribute on the usage
        // element, e.g. {get.placeholder} reads placeholder="..." off
        // <search @SearchBar placeholder="...">. Missing attributes resolve
        // to "" with a console warning rather than failing the whole render.
        const pattern = /\{\s*get\.([\w-]+)\s*\}/g;
        function resolveGet(key) {
            if (key === "content") return content;
            if (Object.prototype.hasOwnProperty.call(attrs, key)) return attrs[key];
            console.error(`Wrap "${wrapId}": template references {get.${key}}, but no "${key}" attribute was set on the usage element. Resolving to "".`);
            return "";
        }

        // --- Step 1: substitute { get.* } in attributes and text nodes ---
        [el, ...el.querySelectorAll("*")].forEach(node => {
            [...node.attributes].forEach(attr => {
                node.setAttribute(attr.name, attr.value.replace(pattern, (_, key) => resolveGet(key)));
            });
            [...node.childNodes].forEach(child => {
                if (child.nodeType === Node.TEXT_NODE) {
                    child.textContent = child.textContent.replace(pattern, (_, key) => resolveGet(key));
                }
            });
        });

        // --- Step 2: existing :Field / :Btn / params rewriting. Only ever
        // matters for wrapIds that came from a real @id (renderWrapUsages
        // guarantees an id-less usage is only allowed when the template
        // has none of these to rewrite in the first place) ---
        [...el.children].forEach(child => {
            [...child.attributes].forEach(attr => {

                // Standalone attribute: :Field
                //
                // IMPORTANT: Element.setAttribute() ALWAYS lowercases the name
                // it's given, for ANY HTML attribute, not only ones parsed from
                // source text -- this is a DOM-spec rule, separate from (and in
                // addition to) the HTML-parser lowercasing that started this
                // whole feature. So `child.setAttribute("@SearchBarField", ...)`
                // immediately becomes "@searchbarfield" the instant it's set,
                // and restoreCase (which recovers case from the page's SOURCE
                // text) can't help, because this name is synthesized at
                // runtime and never appears in the source at all.
                //
                // So the camelCase name is tracked in a side map instead of
                // ever being round-tripped through a real attribute name.
                // registerElements checks this map before falling back to its
                // normal (source-text-based) case recovery.
                if (attr.name.startsWith(":")) {
                    const placeholderName = restoreCase(attr.name.slice(1), ":");
                    const runtimeName = `@${wrapId}${placeholderName}`;
                    child.setAttribute(runtimeName, attr.value); // will be lowercased by the DOM; that's fine, see runtimeIdCase below
                    runtimeIdCase[runtimeName.slice(1).toLowerCase()] = runtimeName.slice(1);
                    child.removeAttribute(attr.name);
                    return;
                }

                // params=":Field" or value=":Btn"
                if (
                    (attr.name === "params" || attr.name === "value") &&
                    attr.value.startsWith(":")
                ) {
                    const value = attr.value.slice(1);

                    child.setAttribute(
                        attr.name,
                        value.includes(":")
                            ? `${wrapId}${value}`
                            : `@${wrapId}${value}`
                    );

                    return;
                }

                // Other attributes
                if (attr.value.startsWith(":")) {
                    child.setAttribute(
                        attr.name,
                        `${wrapId}${attr.value.slice(1)}`
                    );
                }
            });
        });

        // --- Step 3: replace the reference element, which the caller
        // already has a direct handle on (renderWrapUsages is iterating it
        // right now) -- no need to re-search the DOM for an @id marker that
        // might not even exist on an id-less usage ---
        const rootChild = el.firstElementChild;
        if (rootChild) {
            [...referenceElement.attributes].forEach(attr => {
                if (attr.name === `@${wrapId}`) return; // the id marker itself, not forwarded
                rootChild.setAttribute(attr.name, attr.value);
            });
        }

        referenceElement.replaceWith(...el.childNodes);
        return true;
    };

    // One-time: read <wrap tag="..."> template DEFINITIONS out of the
    // <head><wraps> block (just tag name + template, not usages -- usage
    // discovery happens in renderWrapUsages, below, so it can run again
    // later against new subtrees). New wrap TYPES can't be declared after
    // this point (the <wraps> block is consumed and removed below), but
    // new USAGES of an already-declared wrap tag -- with a new @id, added
    // to the page at any point after this -- are discovered live by
    // renderWrapUsages via processRoot.
    //
    // hasPlaceholders is precomputed once per definition: true if the
    // template contains any :-prefixed attribute (:Field, :Btn, ...).
    // Those get namespaced to @{wrapId}Field at render time, which needs
    // a real @id to build from -- so a usage is only allowed to omit its
    // @id when the template has nothing that would need one.
    const wrapDefs = [];
    document.querySelectorAll("wrap").forEach(el => {
        if (!el.hasAttribute("tag"))
            throw new Error(`Cannot create element wrap at ${el.outerHTML}. Missing attribute: "tag"`);

        const template = el.cloneNode(true);
        const hasPlaceholders = [...template.querySelectorAll("*")].some(node =>
            [...node.attributes].some(attr => attr.name.startsWith(":"))
        );

        wrapDefs.push({ tagName: el.getAttribute("tag"), template, hasPlaceholders });
    });

    let anonWrapCount = 0; // backs the synthetic keys used for id-less usages

    // Finds every not-yet-rendered usage of every declared wrap tag within
    // `root` and renders it. A usage disappears from the DOM once rendered
    // (wraps.render replaces it), so re-running this against the same root
    // never re-processes what it already handled -- only genuinely new
    // usages (present at initial load, or inserted afterward) match.
    function renderWrapUsages(root) {
        wrapDefs.forEach(({ tagName, template, hasPlaceholders }) => {
            scoped(root, tagName).forEach(usage => {
                const atAttr = [...usage.attributes].find(attr => attr.name.startsWith("@"));

                if (!atAttr && hasPlaceholders) {
                    throw new Error(`Wrap at ${usage.outerHTML} does not have an identifier. Missing attribute: "@id" (required because <wrap tag="${tagName}"> uses :-prefixed placeholders, which need an id to namespace).`);
                }

                let wrapId;
                if (atAttr) {
                    // atAttr.name is browser-lowercased; recover the original
                    // casing the same way registerElements does.
                    wrapId = restoreCase(atAttr.name.slice(1), "@");
                    if (wraps.hasOwnProperty(wrapId)) {
                        throw new Error(`Duplicate wrap id "@${wrapId}" found.`);
                    }
                } else {
                    wrapId = `__anon${anonWrapCount++}`; // no real id needed -- template has nothing to namespace
                }

                const attrs = {};
                [...usage.attributes].forEach(attr => {
                    if (!atAttr || attr.name !== atAttr.name) attrs[attr.name] = attr.value;
                });

                wraps[wrapId] = {
                    template,              // the <wrap> definition's template
                    content: usage.innerHTML, // this specific usage instance
                    attrs                   // every other attribute on the usage, for {get.*}
                };
                wraps.render(wrapId, usage);
            });
        });
    }

    function registerElements(root) {
        scoped(root, "*").forEach(el => {
            Array.from(el.attributes).forEach(attr => {
                if (attr.name.startsWith("@")) {
                    // attr.name is already lowercased by the browser's parser
                    // (e.g. "@groceryname"); restoreCase looks up the ORIGINAL
                    // casing from the page's raw source ("GroceryName"), falling
                    // back to the lowercase form if that lookup wasn't possible.
                    const lower = attr.name.slice(1);
                    const orgName = runtimeIdCase[lower] ?? restoreCase(lower, "@");

                    if (elements[orgName]) {
                        throw new Error(`Duplicate element identifier: @${orgName}`);
                    }

                    elements[orgName] = el;
                    el.removeAttribute(attr.name);

                    // A developer can now reach the same element either through
                    // Anchor.elements.GroceryName or document.getElementById("GroceryName"),
                    // as long as they haven't already set their own id.
                    if (!el.hasAttribute("id")) el.setAttribute("id", orgName);
                }
            });
        });
    }

    function processFormats(root) {
        scoped(root, "format").forEach(el => {
            if (el.hasAttribute("await")) {
                el.style.display = 'none';
                const args = parseAwaitAttr(el.getAttribute("await"));

                elements[args[0]].addEventListener(`${args[1]}`, (event) => {
                    event.preventDefault();
                    el.querySelectorAll("r").forEach(rtn => {
                        if (!rtn.getAttribute("value").startsWith("[")) {
                            rtn = returnTag(rtn);
                        }
                    });
                    el.style.display = '';
                });
            }
        });
    }

    // ------------------------------------------------------------------
    // Scope helpers (used by <repeat> and by <if> when it lives inside one)
    //
    // Inside a <repeat>, [item.name] means "look up `item` in the loop
    // scope". A bracket is treated as a loop reference ONLY when its root
    // name exists in the current scope, so literal text like [draft] and
    // the existing [@Field] / [$root] fetch-URL syntax are left untouched.
    // \[ escapes a literal bracket when a real scope name collides.
    // ------------------------------------------------------------------
    const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
    const SCOPE_REF = /^\[([A-Za-z_$][\w$]*)((?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])*)\]$/;
    const SCOPE_REF_GLOBAL = /\\\[|\[([A-Za-z_$][\w$]*)((?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])*)\]/g;

    // Returns NOT_SCOPE_REF when `expr` isn't a reference into the loop scope
    // at all (a literal, or an @/$ reference). Anything else is a real lookup,
    // and its result may legitimately be undefined -- e.g. [book.year] on a
    // book with no year. Keeping those two cases apart matters: collapsing
    // both into `undefined` made a MISSING field fall through and be treated
    // as the literal text "[book.year]", which is truthy.
    const NOT_SCOPE_REF = Symbol("not-a-scope-ref");
    function resolveInScope(expr, scope) {
        const m = String(expr).trim().match(SCOPE_REF);
        if (!m || !scope || !Object.prototype.hasOwnProperty.call(scope, m[1])) return NOT_SCOPE_REF;
        return m[2] ? getObjectValue(scope[m[1]], m[2]) : scope[m[1]];
    }

    // Replaces [name.path] in one string. Returns the string unchanged
    // (same reference semantics) if nothing in it referenced the scope.
    function interpolateString(str, scope) {
        return str.replace(SCOPE_REF_GLOBAL, (whole, rootName, path) => {
            if (whole === "\\[") return "[";                    // escaped literal bracket
            if (!Object.prototype.hasOwnProperty.call(scope, rootName)) return whole;
            const value = path ? getObjectValue(scope[rootName], path) : scope[rootName];
            return value == null ? "" : String(value);
        });
    }

    // Walks a cloned subtree and substitutes [scope refs] in text nodes and
    // attribute values. Text goes in as text nodes / setAttribute only,
    // never innerHTML, so item data can't inject markup.
    function interpolateNode(node, scope) {
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        const texts = [];
        while (walker.nextNode()) texts.push(walker.currentNode);
        texts.forEach(t => {
            if (t.textContent.includes("[")) t.textContent = interpolateString(t.textContent, scope);
        });

        const els = node.nodeType === Node.ELEMENT_NODE ? [node, ...node.querySelectorAll("*")] : [...node.querySelectorAll("*")];
        els.forEach(el => {
            [...el.attributes].forEach(attr => {
                // <if test="[item.done]"> is resolved by processIfs (it needs the raw
                // value, not a string), so leave test/comparison attributes alone.
                if (el.tagName === "IF" && ["test", "eq", "neq", "gt", "gte", "lt", "lte", "has"].includes(attr.name)) return;
                if (attr.value.includes("[")) el.setAttribute(attr.name, interpolateString(attr.value, scope));
            });
        });
    }

    // Collects every $root referenced by an <if test="$..."> inside a repeat
    // template, so the repeat can re-render when an OUTER value changes.
    function collectInnerRoots(template) {
        const roots = new Set();
        template.querySelectorAll("if[test]").forEach(ifEl => {
            const t = ifEl.getAttribute("test").trim();
            if (t.startsWith("$")) {
                const m = t.slice(1).match(/^[A-Za-z_$][\w$]*/);
                if (m) roots.add(m[0]);
            }
        });
        return roots;
    }

    // Turns whatever `in` resolved to into a uniform list of entries.
    //   arrays  -> [{ value, key: index }]
    //   objects -> [{ value, key: propertyName }]
    function toEntries(source) {
        if (source == null) return [];
        if (Array.isArray(source)) return source.map((value, key) => ({ value, key }));
        if (typeof source === "object") return Object.keys(source).map(key => ({ value: source[key], key }));
        return [];
    }

    // sort="name"        ascending by item.name
    // sort="-price"      descending
    // sort="name,-price" multi-key
    // Objects sort by the same field names; sort="key" / "-key" orders by property name.
    function applySort(entries, sortAttr) {
        const rules = sortAttr.split(",").map(s => s.trim()).filter(Boolean).map(s => {
            const desc = s.startsWith("-");
            const field = desc ? s.slice(1).trim() : s;
            return { field, desc };
        });
        const fieldOf = (entry, field) => {
            if (field === "key") return entry.key;
            if (field === "value" || field === "") return entry.value;
            const path = field.split(".");
            let v = entry.value;
            for (const p of path) {
                if (v == null || UNSAFE_KEYS.has(p)) return undefined;
                v = v[p];
            }
            return v;
        };
        const cmp = (a, b) => {
            if (a === b) return 0;
            if (a == null) return 1;       // missing values sort last
            if (b == null) return -1;
            const na = Number(a), nb = Number(b);
            if (typeof a !== "boolean" && typeof b !== "boolean" && !Number.isNaN(na) && !Number.isNaN(nb) && a !== "" && b !== "") return na - nb;
            return String(a).localeCompare(String(b));
        };
        return [...entries].sort((x, y) => {
            for (const { field, desc } of rules) {
                const r = cmp(fieldOf(x, field), fieldOf(y, field));
                if (r !== 0) return desc ? -r : r;
            }
            return 0;
        });
    }

    // Names the loop variables from the `as` attribute.
    //   as="item"        -> item
    //   as="key, value"  -> key + value (meant for objects, works on arrays too)
    function parseAs(asAttr, el) {
        const names = asAttr.split(",").map(s => s.trim()).filter(Boolean);
        if (!names.length || names.length > 2 || !names.every(n => /^[A-Za-z_$][\w$]*$/.test(n))) {
            throw new Error(`Invalid "as" at ${el.outerHTML}. Use as="item" or as="key, value".`);
        }
        if (names.some(n => UNSAFE_KEYS.has(n) || n === "loop")) {
            throw new Error(`Invalid "as" at ${el.outerHTML}: "${names.find(n => UNSAFE_KEYS.has(n) || n === "loop")}" is reserved.`);
        }
        return names;
    }

    function processRepeats(root) {
        scoped(root, "repeat").forEach(el => {
            if (!el.hasAttribute("as")) throw new Error(`Incomplete repeat loop at ${el.outerHTML}. Missing attribute: "as"`);
            if (!el.hasAttribute("in")) throw new Error(`Incomplete repeat loop at ${el.outerHTML}. Missing attribute: "in"`);

            const names = parseAs(el.getAttribute("as"), el);
            const sourceAttr = el.getAttribute("in");
            const indexName = el.hasAttribute("index") ? el.getAttribute("index").trim() : null;
            if (indexName !== null && (!/^[A-Za-z_$][\w$]*$/.test(indexName) || UNSAFE_KEYS.has(indexName) || indexName === "loop" || names.includes(indexName))) {
                throw new Error(`Invalid "index" at ${el.outerHTML}: "${indexName}" is not a usable name.`);
            }
            const sortAttr = el.hasAttribute("sort") ? el.getAttribute("sort") : null;
            const limitAttr = el.hasAttribute("limit") ? el.getAttribute("limit") : null;

            // Optional <else> child: rendered only when the (sorted, limited)
            // source has no items. Pulled out of the template so it never
            // repeats per item.
            const template = el.cloneNode(true);
            let emptyTemplate = null;
            const elseChild = [...template.children].find(c => c.tagName === "ELSE" && !c.previousElementSibling?.matches?.("if"));
            // An <else> that directly follows an <if> belongs to that <if>, not
            // to the repeat. Only a "free" <else> (not paired) is the empty state.
            if (elseChild) {
                emptyTemplate = elseChild.cloneNode(true);
                elseChild.remove();
            }

            // Everything above is fixed at setup time, so the per-render path
            // below only does work that actually depends on current data.
            const innerRoots = collectInnerRoots(template);

            function render() {
                let source = getForeignData(sourceAttr, el);
                let entries = toEntries(source);

                if (sortAttr) entries = applySort(entries, sortAttr);

                if (limitAttr !== null) {
                    // limit may be a number or a reference, e.g. limit="$pageSize".
                    // A number that is merely out of range is CLAMPED rather than
                    // rejected: a pager button driving limit below 0 should show
                    // an empty list, not silently flip to "show everything".
                    // Only a value that isn't a number at all is a real error.
                    const raw = foreignId.test(limitAttr) ? getForeignData(limitAttr, el) : limitAttr;
                    const n = raw === null || raw === undefined || raw === "" ? NaN : Number(raw);
                    if (Number.isFinite(n)) {
                        entries = entries.slice(0, Math.max(0, Math.floor(n)));
                    } else {
                        // Describe the element by its attributes, NOT outerHTML:
                        // by now outerHTML holds the whole rendered list.
                        console.error(`Invalid "limit" on <repeat as="${el.getAttribute("as")}" in="${sourceAttr}">: limit="${limitAttr}" resolved to ${JSON.stringify(raw)}, which is not a number. Ignoring limit.`);
                    }
                }

                el.replaceChildren();

                if (!entries.length) {
                    if (emptyTemplate) el.append(...emptyTemplate.cloneNode(true).childNodes);
                    el.style.display = '';
                    return;
                }

                entries.forEach((entry, idx) => {
                    // as="item"       -> item = the value
                    // as="key, value" -> key = property name / index, value = the value
                    const scope = names.length === 2
                        ? { [names[0]]: entry.key, [names[1]]: entry.value }
                        : { [names[0]]: entry.value };
                    if (indexName) scope[indexName] = idx;
                    scope.loop = {
                        number: idx + 1,
                        index: idx,
                        first: idx === 0,
                        last: idx === entries.length - 1,
                        length: entries.length
                    };

                    const clone = template.cloneNode(true);

                    // Legacy <r value="item.name"> support (same engine, old pages keep working).
                    clone.querySelectorAll("r").forEach(r => {
                        const tag = returnTag(r, { direct: true });
                        const rootName = String(tag).split(".")[0];
                        if (!Object.prototype.hasOwnProperty.call(scope, rootName))
                            throw new Error(`Invalid object name reference at "value" attribute of ${r.outerHTML}`);
                        const notation = String(tag).slice(rootName.length);
                        const value = notation ? getObjectValue(scope[rootName], notation) : scope[rootName];
                        r.replaceWith(document.createTextNode(value == null ? "" : String(value)));
                    });

                    // [item.name] substitution in text and attributes.
                    interpolateNode(clone, scope);

                    // Conditions inside the loop are evaluated once per item,
                    // against that item's scope, and the losing branch is
                    // removed outright (see processIfs) instead of hidden.
                    processIfs(clone, scope);

                    el.append(...clone.childNodes);
                });

                el.style.display = '';
            }

            // Reactivity: re-render when the source root, or any $root an
            // inner <if> depends on, changes.
            const watchRoots = new Set(innerRoots);
            if (sourceAttr.trim().startsWith('$')) {
                const m = sourceAttr.trim().slice(1).match(/^[A-Za-z_$][\w$]*/);
                if (m) watchRoots.add(m[0]);
            }
            if (limitAttr && limitAttr.trim().startsWith('$')) {
                const m = limitAttr.trim().slice(1).match(/^[A-Za-z_$][\w$]*/);
                if (m) watchRoots.add(m[0]);
            }
            watchRoots.forEach(r => Anchor.watch(r, render));

            if (el.hasAttribute("await")) {
                el.style.display = 'none';
                const args = parseAwaitAttr(el.getAttribute("await"));

                elements[args[0]].addEventListener(args[1], (event) => {
                    event.preventDefault();
                    render();
                });
            } else {
                render();
            }
        });
    }

    // `scope` is only passed when this runs inside a <repeat> item. In that
    // mode conditions are decided once and the losing branch is REMOVED from
    // the clone (a 500-item list shouldn't leave 500 hidden nodes behind);
    // the repeat re-renders itself whenever any input changes, so there is
    // nothing for a per-item <if> to watch. Outside a repeat (scope
    // undefined) behavior is unchanged: display toggling + watchers.
    function processIfs(root, scope) {
        scoped(root, "if").forEach(el => {
            if (!el.hasAttribute("test"))
                throw new Error(`Incomplete if at ${el.outerHTML}. Missing attribute: "test"`);

            const testAttr = el.getAttribute("test");
            const negate = el.hasAttribute("not");

            // "has" is unary (no compare value needed): true unless the
            // resolved test value is null, undefined, or "". Distinct from
            // the bare-test truthy fallback below -- 0 and false "exist"
            // for has, but are falsy for a plain <if test="...">.
            const COMPARATORS = ["eq", "neq", "gt", "gte", "lt", "lte", "has"];
            const op = COMPARATORS.find(o => el.hasAttribute(o));
            let compareRaw = op ? el.getAttribute(op) : null;
            if (scope && compareRaw !== null) {
                const fromScope = resolveInScope(compareRaw, scope);
                if (fromScope !== NOT_SCOPE_REF) compareRaw = fromScope;
            }

            // An <else> is only recognized if it's the very next sibling element.
            const nextEl = el.nextElementSibling;
            const elseEl = (nextEl && nextEl.tagName === "ELSE") ? nextEl : null;

            // If both sides look numeric, compare as numbers; otherwise compare as strings.
            function coerce(a, b) {
                // A real boolean from data vs the literal "true"/"false" written in
                // markup (eq="false"): `false == "false"` is false in JS, so turn
                // the markup side into a boolean first.
                const toBool = v => v === "true" ? true : v === "false" ? false : v;
                if (typeof a === "boolean" || typeof b === "boolean") return [toBool(a), toBool(b)];

                const na = Number(a), nb = Number(b);
                if (a !== "" && b !== "" && a != null && b != null && !Number.isNaN(na) && !Number.isNaN(nb)) {
                    return [na, nb];
                }
                return [a, b];
            }

            // `test` normally requires @/$/[] foreign-reference syntax. But
            // inside a <wrap> template, {get.sender}-style placeholders are
            // already resolved to a plain literal (e.g. "left") by the time
            // this runs -- there's no reference left to look up. So: if
            // testAttr doesn't look like a reference at all, treat it as a
            // literal value directly instead of erroring. This does mean a
            // genuine typo like test="Age" (meant "@Age") silently becomes
            // the literal string "Age" rather than a loud error -- worth
            // knowing if that trade-off ever bites.
            function resolveTest() {
                if (scope) {
                    const fromScope = resolveInScope(testAttr, scope);
                    if (fromScope !== NOT_SCOPE_REF) return fromScope;
                }
                return foreignId.test(testAttr) ? getForeignData(testAttr, el) : testAttr;
            }

            function evaluate() {
                const raw = resolveTest();
                let result;

                if (op === "has") {
                    result = raw !== null && raw !== undefined && raw !== "";
                } else if (op) {
                    const [a, b] = coerce(raw, compareRaw);
                    switch (op) {
                        case "eq": result = a == b; break;
                        case "neq": result = a != b; break;
                        case "gt": result = a > b; break;
                        case "gte": result = a >= b; break;
                        case "lt": result = a < b; break;
                        case "lte": result = a <= b; break;
                    }
                } else {
                    result = Array.isArray(raw) ? raw.length > 0 : !!raw;
                }

                if (negate) result = !result;

                if (scope) {
                    // Inside a repeat item: keep the winning branch's contents in
                    // place, drop the tags themselves and the losing branch.
                    const winner = result ? el : elseEl;
                    if (winner) winner.replaceWith(...winner.childNodes);
                    const loser = result ? elseEl : el;
                    if (loser) loser.remove();
                    return;
                }

                el.style.display = result ? '' : 'none';
                if (elseEl) elseEl.style.display = result ? 'none' : '';
            }

            if (scope) {
                evaluate();
                return;
            }

            const hasAwait = el.hasAttribute("await");

            // If this if/else is event-driven, keep BOTH branches hidden
            // until that event actually fires at least once -- otherwise
            // it evaluates against whatever (probably empty/default) data
            // happens to exist at page-load time and shows a branch that
            // has nothing to do with any real input yet.
            if (hasAwait) {
                el.style.display = 'none';
                if (elseEl) elseEl.style.display = 'none';
            } else {
                evaluate();
            }

            // Reactive: auto re-evaluate whenever a $-exposed root changes.
            if (testAttr.trim().startsWith('$')) {
                const watchRoot = testAttr.trim().slice(1).match(/^[A-Za-z_$][\w$]*/)[0];
                Anchor.watch(watchRoot, evaluate);
            }

            // Event-driven: for @element-based conditions that aren't reactive on their own.
            if (hasAwait) {
                const args = parseAwaitAttr(el.getAttribute("await"));
                elements[args[0]].addEventListener(args[1], (event) => {
                    event.preventDefault();
                    evaluate();
                });
            }
        });
    }

    // <input bind="$user.name"> -- two-way sync between a form control and
    // a reactive value. Typing updates the data; the data changing anywhere
    // else (another bind, a fetch response, $Items.push, etc.) updates what
    // the control shows. Works on input/textarea/select; checkboxes sync
    // via `checked` instead of `value`.
    function processBinds(root) {
        scoped(root, "[bind]").forEach(el => {
            const raw = el.getAttribute("bind").trim();
            el.removeAttribute("bind");

            if (!raw.startsWith("$")) {
                console.error(`Invalid "bind" at ${el.outerHTML}: must reference a $-exposed value, e.g. bind="$user.name". Skipping.`);
                return;
            }

            if (!["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) {
                console.error(`"bind" at ${el.outerHTML} is only supported on <input>, <textarea>, and <select>. Skipping.`);
                return;
            }

            const ref = parseDollarPath(raw);
            if (!ref) throw new Error(`Invalid bind path at ${el.outerHTML}: "${raw}"`);
            const { rootKey, path } = ref;

            if (!Object.prototype.hasOwnProperty.call(Anchor._data, rootKey)) {
                console.error(`"${rootKey}" was not found. Did you forget to call Anchor.expose({ ${rootKey} })? Skipping bind at ${el.outerHTML}.`);
                return;
            }

            const isCheckbox = el.type === "checkbox";
            const isRadio = el.type === "radio";

            function pull() { // data -> element
                const value = path ? getObjectValue(Anchor._data[rootKey], path) : Anchor._data[rootKey];
                if (isCheckbox) {
                    el.checked = !!value;
                } else if (isRadio) {
                    el.checked = (el.value === String(value));
                } else if (el.value !== (value ?? "").toString()) {
                    el.value = value ?? "";
                }
            }

            function push() { // element -> data
                const value = isCheckbox ? el.checked : el.value;
                if (path) {
                    setObjectValue(Anchor._data[rootKey], path, value);
                } else {
                    // Root-level primitive (bind="$count"): there's no proxy
                    // property assignment to intercept at this depth, so
                    // write directly and notify by hand -- same thing
                    // Anchor.expose() itself does on (re-)exposure.
                    Anchor._data[rootKey] = value;
                    Anchor._notify(rootKey);
                }
            }

            pull();
            el.addEventListener(isCheckbox || isRadio || el.tagName === "SELECT" ? "change" : "input", push);
            Anchor.watch(rootKey, pull);
        });
    }

    // Shared by bind and pushto: parses "$root" or "$root.path[0].etc" into
    // { rootKey, path }, or returns null if it isn't a $-reference at all.
    function parseDollarPath(raw) {
        const trimmed = raw.trim();
        if (!trimmed.startsWith("$")) return null;

        const clean = trimmed.slice(1);
        const match = clean.match(/^([A-Za-z_$][A-Za-z0-9_$]*)((?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])*)$/);
        if (!match) return null;

        return { rootKey: match[1], path: match[2] };
    }

    // <form pushto="$userData"> -- on submit, collects every named form
    // control into a fresh object (keyed by each field's `name` attribute;
    // fields with no `name` are skipped) and writes the whole thing to the
    // target in one shot. Complements bind: bind is per-field, live, two-way;
    // pushto is whole-form, submit-time, one-way (form -> data).
    function processPushTo(root) {
        scoped(root, "form[pushto]").forEach(form => {
            const raw = form.getAttribute("pushto");
            form.removeAttribute("pushto");

            const ref = parseDollarPath(raw);
            if (!ref) {
                console.error(`Invalid "pushto" at ${form.outerHTML}: must reference a $-exposed value, e.g. pushto="$userData". Skipping.`);
                return;
            }
            const { rootKey, path } = ref;

            if (!Object.prototype.hasOwnProperty.call(Anchor._data, rootKey)) {
                console.error(`"${rootKey}" was not found. Did you forget to call Anchor.expose({ ${rootKey} })? Skipping pushto at ${form.outerHTML}.`);
                return;
            }

            form.addEventListener("submit", (event) => {
                event.preventDefault();

                const data = {};
                form.querySelectorAll("input, textarea, select").forEach(field => {
                    const name = field.getAttribute("name");
                    if (!name) return; // no name attribute -> not included

                    if (["submit", "button", "reset"].includes(field.type)) {
                        return; // the button itself isn't form data
                    } else if (field.type === "checkbox") {
                        data[name] = field.checked; // boolean, not the raw "on"/absent HTML behavior
                    } else if (field.type === "radio") {
                        if (field.checked) data[name] = field.value; // unchecked siblings just don't overwrite
                    } else if (field.tagName === "SELECT" && field.multiple) {
                        data[name] = [...field.selectedOptions].map(o => o.value);
                    } else {
                        data[name] = field.value;
                    }
                });

                if (path) {
                    setObjectValue(Anchor._data[rootKey], path, data);
                } else {
                    // Root-level target (no nested path): mutate the EXISTING
                    // exposed object in place rather than replacing the
                    // reference. If we did `Anchor._data[rootKey] = data`
                    // here, that would leave any already-destructured local
                    // (`let { userData } = Anchor.expose(...)`) pointing at
                    // the old, now-stale object -- objects are reference
                    // types, but reassigning Anchor._data doesn't reach back
                    // and update a variable that already copied the old
                    // reference. Deleting old keys and assigning the new
                    // ones onto the SAME object keeps that reference live,
                    // and each delete/set still goes through the reactive
                    // proxy's traps, so watchers still fire correctly.
                    const target = Anchor._data[rootKey];
                    if (target !== null && typeof target === "object") {
                        Object.keys(target).forEach(key => { delete target[key]; });
                        Object.assign(target, data);
                    } else {
                        // Root was exposed as a non-object (or never properly
                        // initialized as one) -- nothing to mutate in place,
                        // so fall back to a plain replace + manual notify.
                        Anchor._data[rootKey] = data;
                        Anchor._notify(rootKey);
                    }
                }
            });
        });
    }

    // <fetch @Weather url="https://.../forecast?city=[@City]" pushto="$weather" await="Form:submit">
    // -- a declarative HTTP request. pushto is required, same rule as <form
    // pushto>: its target must already be exposed, or processFetches throws.
    // There is no implicit @id-derived data root anymore -- @id still
    // registers the element (so other directives can await="Weather:invoke"
    // / "Weather:error"), but it no longer doubles as a data name.
    //
    // loading/error are NOT attributes you set -- they're derived
    // automatically as siblings of pushto's root key:
    //   pushto="$weather"  ->  $weatherLoading (bool), $weatherError (string|null)
    // Unlike pushto's own target, loading/error are Anchor's own bookkeeping,
    // so they're auto-exposed on demand rather than requiring the page
    // author to pre-expose them.
    //
    // Seeds loadingKey/errorKey up front, before <repeat>/<if>/bind run,
    // same reason as before: those directives read `$id` while the page is
    // being wired up, and the fetch itself doesn't actually run until later
    // in the pipeline (or not until its await fires).
    function seedFetchRoots(root) {
        scoped(root, "fetch[pushto]").forEach(el => {
            const ref = parseDollarPath(el.getAttribute("pushto"));
            if (!ref) return; // processFetches reports the invalid pushto
            const loadingKey = ref.rootKey + "Loading";
            const errorKey = ref.rootKey + "Error";
            if (!Object.prototype.hasOwnProperty.call(Anchor._data, loadingKey)) {
                Anchor.expose({ [loadingKey]: false });
            }
            if (!Object.prototype.hasOwnProperty.call(Anchor._data, errorKey)) {
                Anchor.expose({ [errorKey]: null });
            }
        });
    }

    function processFetches(root) {
        scoped(root, "fetch").forEach(el => {
            const idEntry = Object.entries(elements).find(([, v]) => v === el);
            if (!idEntry) throw new Error(`<fetch> at ${el.outerHTML} is missing an identifier. Missing attribute: "@id". Still required -- it's the dispatch target for await="X:invoke"/"X:error" elsewhere, it just no longer names the data.`);
            const id = idEntry[0];

            if (!el.hasAttribute("url"))
                throw new Error(`Incomplete <fetch> at ${el.outerHTML}. Missing attribute: "url"`);
            if (!el.hasAttribute("pushto"))
                throw new Error(`Incomplete <fetch> at ${el.outerHTML}. Missing attribute: "pushto", e.g. pushto="$weather". A <fetch> no longer stores its response under its own @id.`);

            const ref = parseDollarPath(el.getAttribute("pushto"));
            if (!ref) {
                throw new Error(`Invalid "pushto" at ${el.outerHTML}: must reference a $-exposed value, e.g. pushto="$weather".`);
            }
            const { rootKey, path } = ref;

            if (!Object.prototype.hasOwnProperty.call(Anchor._data, rootKey)) {
                throw new Error(`"${rootKey}" was not found. Did you forget to call Anchor.expose({ ${rootKey} })? <fetch pushto="$${rootKey}"> at ${el.outerHTML} needs its target exposed first.`);
            }

            const urlTemplate = el.getAttribute("url");
            const method = (el.getAttribute("method") || "GET").toUpperCase();
            const parseAs = el.getAttribute("parse") || "json";

            // loading/error: derived siblings off rootKey, always root-level
            // regardless of whether pushto itself targets a nested path.
            // Auto-exposed here too (seedFetchRoots already did this before
            // the pipeline ran, but this covers a <fetch> added later via
            // Anchor.mount, same as any other directive's self-seeding).
            const loadingKey = rootKey + "Loading";
            const errorKey = rootKey + "Error";
            if (!Object.prototype.hasOwnProperty.call(Anchor._data, loadingKey)) {
                Anchor.expose({ [loadingKey]: false });
            }
            if (!Object.prototype.hasOwnProperty.call(Anchor._data, errorKey)) {
                Anchor.expose({ [errorKey]: null });
            }

            // [@City], [$user.name], etc. inside the URL -- resolved through
            // the same getForeignData every other directive uses, then
            // encoded, so a value with spaces/&/? can't corrupt the request
            // or inject extra query params.
            function resolveUrl() {
                return urlTemplate.replace(/\[([^\]]+)\]/g, (_, ref) => {
                    const value = getForeignData(ref.trim(), el);
                    return encodeURIComponent(value == null ? "" : value);
                });
            }

            // Every request gets a number. If a newer request starts before an older
            // one finishes, the older response is thrown away when it lands, so a
            // slow first search can't overwrite the results of a fast second one.
            let latest = 0;

            // Writes a successful response to the pushto target ONLY -- this
            // never touches loadingKey/errorKey, and nothing else ever writes
            // to rootKey. That's the whole fix: success, loading and error
            // are three independent roots, so a failed refetch can't
            // overwrite the last good response, and a <repeat in="$weather">
            // never blanks out just because a request is in flight.
            //
            // Same in-place-mutate-vs-replace rule as <form pushto>: a
            // nested path writes via setObjectValue; a bare root mutates the
            // existing object in place (so an already-destructured local
            // stays live) unless the incoming value isn't an object, in
            // which case it falls back to a plain replace + notify.
            function storeSuccess(value) {
                if (path) {
                    setObjectValue(Anchor._data[rootKey], path, value);
                    return;
                }
                const target = Anchor._data[rootKey];
                if (target !== null && typeof target === "object" && value !== null && typeof value === "object") {
                    Object.keys(target).forEach(key => { delete target[key]; });
                    Object.assign(target, value);
                } else {
                    Anchor._data[rootKey] = Anchor._reactive(value, rootKey);
                    Anchor._notify(rootKey);
                }
            }

            function setLoading(v) {
                Anchor._data[loadingKey] = v;
                Anchor._notify(loadingKey);
            }
            function setError(v) {
                Anchor._data[errorKey] = v;
                Anchor._notify(errorKey);
            }

            async function run() {
                const mine = ++latest;

                let body;
                if (el.hasAttribute("body") && method !== "GET") {
                    const raw = getForeignData(el.getAttribute("body"), el);
                    body = typeof raw === "string" ? raw : JSON.stringify(raw);
                }

                setLoading(true);
                setError(null); // clear any previous failure the moment a new attempt starts
                try {
                    const res = await fetch(resolveUrl(), {
                        method,
                        headers: body ? { "Content-Type": "application/json" } : undefined,
                        body
                    });
                    if (mine !== latest) return; // a newer request superseded this one

                    // fetch() only rejects on network failure; a 404/500 still resolves.
                    // Treat those as errors instead of handing the error body to the page as data.
                    if (!res.ok) {
                        let detail = "";
                        try { detail = (await res.text()).slice(0, 200); } catch { }
                        throw new Error(`HTTP ${res.status}${res.statusText ? " " + res.statusText : ""}${detail ? ": " + detail : ""}`);
                    }

                    const data = parseAs === "text" ? await res.text() : await res.json();
                    if (mine !== latest) return; // superseded while the body was downloading

                    storeSuccess(data);
                    setLoading(false);
                    el.dispatchEvent(new Event("invoke"));
                } catch (err) {
                    if (mine !== latest) return;
                    console.error(`<fetch pushto="$${rootKey}"> failed: ${err.message}`);
                    setError(err.message); // $weather itself is untouched -- last good response stays put
                    setLoading(false);
                    // "error" and "invoke" are separate on purpose: chain on
                    // X:invoke for success only, X:error for failure.
                    el.dispatchEvent(new Event("error"));
                }
            }

            if (el.hasAttribute("await")) {
                const args = parseAwaitAttr(el.getAttribute("await"));
                if (!elements[args[0]]) {
                    console.error(`<fetch pushto="$${rootKey}"> awaits "${el.getAttribute("await")}", but no element "@${args[0]}" is registered. Skipping.`);
                    return;
                }
                elements[args[0]].addEventListener(args[1], (event) => {
                    event.preventDefault();
                    run();
                });
            } else {
                run();
            }
        });
    }

    function processCalls(root) {
        scoped(root, "call").forEach(el => {
            let args = null;
            let name = null;
            let params = null;
            let needsReturn = false;
            let hasAwait = false;

            el.addEventListener("invoke", () => { });

            if (!el.hasAttribute("fn")) throw new Error(`Incomplete call at ${el.tagName}. Missing attribute: "fn"`);
            else name = el.getAttribute("fn");

            if (el.hasAttribute("return")) needsReturn = true;
            if (el.hasAttribute("pend")) hasAwait = true;

            if (el.hasAttribute("await")) {
                args = parseAwaitAttr(el.getAttribute("await"));
                elements[args[0]].addEventListener(`${args[1]}`, (event) => {
                    event.preventDefault();
                    if (el.hasAttribute("params")) params = getForeignData(el.getAttribute("params"));

                    if (typeof Anchor._fns[name] !== "function") {
                        console.error(`Function "${name}" called at ${el.outerHTML} was not exposed. Did you forget to call Anchor.exposeFunctions({ ${name} })? Skipping.`);
                        return;
                    }

                    if (!needsReturn) {
                        if (!hasAwait) {
                            Anchor._fns[name](...(params == null ? [] : Array.isArray(params) ? params : [params]));
                            el.dispatchEvent(new Event("invoke"));
                        } else {
                            (async () => {
                                await Anchor._fns[name](...(params == null ? [] : Array.isArray(params) ? params : [params]));
                                el.dispatchEvent(new Event("invoke"));
                            })();
                        }
                    } else {
                        if (!el._Span) {
                            el._Span = document.createElement("span");
                            el.after(el._Span);
                            el.dispatchEvent(new Event("invoke"));
                        }
                        if (!hasAwait) {
                            el._Span.innerHTML = Anchor._fns[name](
                                ...(params == null ? [] : Array.isArray(params) ? params : [params])
                            );
                            el.dispatchEvent(new Event("invoke"));
                        } else {
                            (async () => {
                                el._Span.innerHTML = await Anchor._fns[name](...(params == null ? [] : Array.isArray(params) ? params : [params]));
                                el.dispatchEvent(new Event("invoke"));
                            })();
                        }
                    }
                });
            } else {
                if (el.hasAttribute("params")) params = getForeignData(el.getAttribute("params"));

                if (typeof Anchor._fns[name] !== "function") {
                    console.error(`Function "${name}" called at ${el.outerHTML} was not exposed. Did you forget to call Anchor.exposeFunctions({ ${name} })? Skipping.`);
                    return;
                }

                if (!needsReturn) {
                    Anchor._fns[name](...(params == null ? [] : Array.isArray(params) ? params : [params]));
                } else {
                    if (!el._Span) {
                        el._Span = document.createElement("span");
                        el.after(el._Span);
                    }

                    el._Span.innerHTML = Anchor._fns[name](
                        ...(params == null ? [] : Array.isArray(params) ? params : [params])
                    );
                }

                el.dispatchEvent(new Event("invoke"));
            }
        });
    }

    function replaceTag(tag, style, attr, root) {
        scoped(root, tag).forEach(el => {
            const span = document.createElement("span");
            span.innerHTML = el.innerHTML;

            span.style[style] = attr
                ? el.getAttribute(attr)
                : tag === "up"
                    ? "uppercase"
                    : tag === "low"
                        ? "lowercase"
                        : "capitalize";

            if (tag === "h") {
                const bg = el.getAttribute("c");
                span.style.backgroundColor = bg;
                span.style.color = getContrastColor(bg);
            }

            el.replaceWith(span);
        });
    }

    function processStyles(root) {
        replaceTag("fo", "fontFamily", "name", root);
        replaceTag("up", "textTransform", undefined, root);
        replaceTag("low", "textTransform", undefined, root);
        replaceTag("cap", "textTransform", undefined, root);
        replaceTag("h", "backgroundColor", "c", root);
    }

    function returnTag(rtn, { hasLoop = false, direct = false, onlyAddress = false } = {}) {
        let returnValue, refValue;

        if (rtn.hasAttribute("value")) {
            returnValue = rtn.getAttribute("value");
            if (!returnValue.trim()) {
                return;
            }

            if (foreignId.test(returnValue)) {
                if (direct) {
                    return getForeignData(returnValue, rtn);
                } else {
                    rtn.innerHTML = getForeignData(returnValue, rtn);
                }
            } else {
                if (!direct) {
                    rtn.innerHTML = returnValue;
                } else {
                    return returnValue;
                }
            }

            return rtn;
        }

    }

    function getObjectValue(data, address) {
        const parts = address.match(/\[([^\]]+)\]|\.([A-Za-z_$][\w$]*)/g);

        if (!parts) return data;

        let value = data;

        for (const part of parts) {
            if (value == null) return undefined; // e.g. $results.objects while $results is still null
            const key = part.startsWith("[")
                ? part.slice(1, -1)
                : part.slice(1);

            if (UNSAFE_KEYS.has(key)) {
                console.error(`Blocked access to unsafe key "${key}" in path "${address}".`);
                return undefined;
            }
            if (value == null) return undefined;
            value = value[key];
        }

        return value;
    }

    // Mirrors getObjectValue, but assigns instead of reads. Walking through
    // `data` (the reactive proxy for that root) means the final assignment
    // hits the proxy's set trap and notifies watchers -- same mechanism as
    // GroceryList.push, just one property deep instead of inside an array
    // method.
    function setObjectValue(data, address, value) {
        const parts = address.match(/\[([^\]]+)\]|\.([A-Za-z_$][\w$]*)/g);
        if (!parts || !parts.length) return; // caller handles the root-level (no path) case itself

        let target = data;
        for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i];
            const key = part.startsWith("[") ? part.slice(1, -1) : part.slice(1);
            if (UNSAFE_KEYS.has(key)) {
                console.error(`Blocked write to unsafe key "${key}" in path "${address}".`);
                return;
            }
            target = target[key];
        }

        const last = parts[parts.length - 1];
        const key = last.startsWith("[") ? last.slice(1, -1) : last.slice(1);
        if (UNSAFE_KEYS.has(key)) {
            console.error(`Blocked write to unsafe key "${key}" in path "${address}".`);
            return;
        }
        target[key] = value;
    }

    function getForeignData(id, el) {
        // split on commas, but not commas inside [ ... ] literals
        const parts = id.split(/,(?![^\[\]]*\])/).map(p => p.trim()).filter(Boolean);
        const results = [];

        for (const part of parts) {
            if (!foreignId.test(part)) {
                console.error(`Invalid foreign ID "${part}" at ${el.outerHTML} \n Missing symbol: (@, $, [])`);
                results.push(undefined);
                continue;
            }

            const clean = part.replace(/[$@\[\]]/g, '');

            if (part.startsWith('@')) {
                // `clean` came from an ATTRIBUTE VALUE (e.g. value="@Form"),
                // which the browser does NOT lowercase -- unlike an attribute
                // NAME (e.g. @Form as a bare attribute), so this is already
                // whatever case the developer wrote. registerElements keys
                // `elements` by that same original case, so look it up as-is.
                const key = clean;
                if (elements[key]) {
                    results.push(elements[key].value);
                } else {
                    console.error(`Element mentioned at ${el.outerHTML} was not found: "${key}"`);
                    results.push(undefined);
                }
            } else if (part.startsWith('[')) {
                results.push(clean);
            } else if (/^[A-Za-z_$][A-Za-z0-9_$]*((?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])*)$/.test(clean)) {
                const match = clean.match(/^([A-Za-z_$][A-Za-z0-9_$]*)((?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])*)$/);
                const [, root, path] = match;

                if (!Object.prototype.hasOwnProperty.call(Anchor._data, root)) {
                    console.error(`"${root}" was not found. Did you forget to call Anchor.expose({ ${root} })?`);
                    results.push(undefined);
                } else {
                    results.push(path ? getObjectValue(Anchor._data[root], path) : Anchor._data[root]);
                }
            } else {
                results.push(undefined);
            }
        }

        return results.length === 1 ? results[0] : results;
    }

    function getContrastColor(color) {
        const ctx = document.createElement("canvas").getContext("2d");
        ctx.fillStyle = color;

        const rgb = ctx.fillStyle.match(/\d+/g).map(Number);
        const [r, g, b] = rgb;

        const brightness = (r * 299 + g * 587 + b * 114) / 1000;

        return brightness > 128 ? "black" : "white";
    }

    // Runs the full directive pipeline scoped to `root`, in the same order
    // as the initial pass below: wraps first (a usage may contain elements
    // other directives depend on), then @id registration, then the
    // control-flow / call tags, then cosmetic style tags last.
    function processRoot(root) {
        renderWrapUsages(root);
        seedFetchRoots(root);
        registerElements(root);
        processFormats(root);
        processRepeats(root);
        processIfs(root);
        processBinds(root);
        processPushTo(root);
        processFetches(root);
        processCalls(root);
        processStyles(root);
    }

    Anchor.createWrap = function (tagName, id, innerHTML = "", attrs = {}) {
        const def = wrapDefs.find(d => d.tagName.toLowerCase() === String(tagName).toLowerCase());
        if (!def) throw new Error(`Anchor.createWrap: no <wrap tag="${tagName}"> has been declared.`);
        if (!id && def.hasPlaceholders) {
            throw new Error(`Anchor.createWrap: an identifier is required for "${tagName}" (its template uses :-prefixed placeholders, which need an id to namespace). Pass an id, or remove the placeholders from the <wrap> definition.`);
        }

        const el = document.createElement(def.tagName);
        if (id) el.setAttribute(`@${id}`, "");

        Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, value));
        el.innerHTML = innerHTML;

        // Deliberately NOT expanded here. It's a plain, inert element until
        // Anchor.mount (or any other insertion into document.body's subtree)
        // puts it in the live document -- at that point the same
        // MutationObserver that handles hand-authored dynamic markup expands
        // it, runs the duplicate-@id check, etc. One code path either way.
        return el;
    };

    Anchor.mount = function (el, target, position = "append") {
        let targetEl;

        if (target instanceof Element) {
            targetEl = target;
        } else if (typeof target === "string" && target.startsWith("@")) {
            // target.slice(1) is exactly what the caller typed in their own JS --
            // never parsed as HTML, so never browser-lowercased. Look it up as-is.
            targetEl = elements[target.slice(1)];
            if (!targetEl) throw new Error(`Anchor.mount: no element registered as "${target}".`);
        } else if (typeof target === "string") {
            targetEl = document.querySelector(target);
            if (!targetEl) throw new Error(`Anchor.mount: no element found for selector "${target}".`);
        } else {
            throw new Error(`Anchor.mount: target must be an Element, a CSS selector, or an "@id" reference.`);
        }

        switch (position) {
            case "append": targetEl.appendChild(el); break;
            case "prepend": targetEl.prepend(el); break;
            case "before": targetEl.before(el); break;
            case "after": targetEl.after(el); break;
            case "replace": targetEl.replaceWith(el); break;
            default: throw new Error(`Anchor.mount: unknown position "${position}" (use append/prepend/before/after/replace).`);
        }

        return el;
    };

    // Anchor.loop(source, render, reactive = false) -- JS-side list
    // rendering with no <repeat> tag in the markup. Returns a container
    // Element meant to be handed straight to Anchor.mount:
    //
    //   let { GroceryList } = Anchor.expose({ GroceryList: [] });
    //   Anchor.mount(
    //       Anchor.loop(GroceryList, item => `<li>${item.name}</li>`, true),
    //       "@List"
    //   );
    //
    // `render(value, key)` is a plain function returning an HTML string per
    // entry -- key is the index for an array, the property name for an
    // object, same shape as <repeat>'s internal entries. No $/@/[] Anchor
    // syntax runs inside it, just template literals, and NO auto-escaping:
    // if you're interpolating untrusted text, escape it yourself.
    //
    // reactive = false (default): source is read ONCE, right now, as a
    // plain value. The returned container is static from then on -- call
    // Anchor.loop again (and re-mount, or replace the old container) if you
    // need it to reflect a later change.
    //
    // reactive = true: source must be a value that came directly out of
    // Anchor.expose() (or Anchor._data) -- a stable, TOP-LEVEL reactive
    // reference, the same requirement pushto's target already has to meet.
    // Anchor.loop resolves it back to its root key via _rootOf and
    // Anchor.watch()es that root, re-rendering the SAME container's
    // contents in place whenever it changes -- once mounted, it keeps
    // itself current with no further calls needed. A value read off a
    // *nested* path (e.g. user.addresses) won't resolve, because nested
    // reads return a freshly-wrapped proxy every time rather than a stable
    // one -- Anchor.loop falls back to a one-shot render and logs why.
    Anchor.loop = function (source, render, reactive = false) {
        if (typeof render !== "function") {
            console.error("Anchor.loop(): \"render\" must be a function. Rendering nothing.");
            return document.createElement("div");
        }

        // display: contents -- this wrapper is purely a handle for
        // Anchor.mount to insert/replace; it shouldn't add a box of its own
        // to the layout (e.g. between a <ul> and its <li>s).
        const container = document.createElement("div");
        container.style.display = "contents";

        function paint(value) {
            const entries = toEntries(value);
            container.innerHTML = entries.map(({ value, key }) => render(value, key)).join("");
        }

        if (!reactive) {
            paint(source);
            return container;
        }

        const rootKey = Anchor._rootOf.get(source);
        if (!rootKey) {
            console.error("Anchor.loop(): reactive=true requires a value that came directly from Anchor.expose() (or Anchor._data) -- e.g. Anchor.loop(GroceryList, ..., true) where `let { GroceryList } = Anchor.expose({ GroceryList: [] })`. Rendering once instead.");
            paint(source);
            return container;
        }

        // Re-reads Anchor._data[rootKey] fresh on every change rather than
        // closing over `source`, so this still works even if something
        // (e.g. <fetch pushto> replacing a non-object root) swaps in an
        // entirely new value under that key rather than mutating in place.
        paint(Anchor._data[rootKey]);
        Anchor.watch(rootKey, () => paint(Anchor._data[rootKey]));
        return container;
    };

    // ---- Initial synchronous pass over the document as it was parsed ----
    renderWrapUsages(document);

    try {
        document.querySelector("wraps").remove();
    } catch { }

    seedFetchRoots(document);
    registerElements(document);
    processFormats(document);
    processRepeats(document);
    processIfs(document);
    processBinds(document);
    processPushTo(document);
    processFetches(document);
    processCalls(document);
    processStyles(document);

    // ---- Live pass: anything inserted into the page after this point runs
    // through the same pipeline, scoped to just the inserted subtree, so
    // Anchor markup added dynamically (via innerHTML, appendChild, another
    // library, etc.) is wired up without a manual re-init call. New <wrap>
    // TYPE definitions still have to exist at initial load (the <wraps>
    // block above is already consumed and removed by this point), but new
    // USAGES of an existing wrap tag, plus @id elements, <call>, <if>,
    // <repeat>, <format>, and the style tags, all work live. ----
    const observer = new MutationObserver(mutations => {
        mutations.forEach(mutation => {
            mutation.addedNodes.forEach(node => {
                if (node.nodeType === Node.ELEMENT_NODE) processRoot(node);
            });
        });
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Everything above this line has run: the case-recovery fetch settled,
    // Anchor.mount/createWrap/loop are assigned, the initial document pass
    // is done, and the live-insertion observer is watching. Safe from here on.
    _resolveReady();
});


function isJSON(str) {
    try {
        JSON.parse(str);
        return true;
    } catch {
        return false;
    }
}

function parseAwaitAttr(str) {
    // str comes from an ATTRIBUTE VALUE (await="Form:submit"), which the
    // browser does NOT lowercase, unlike an attribute NAME -- so args[0] is
    // already the exact case the developer wrote, matching how
    // registerElements keys `elements`. Do not lowercase it.
    let args = str.split(":");
    return args;
}

function getLength(value) {
    return Array.isArray(value)
        ? value.length
        : Object.keys(value).length;
}