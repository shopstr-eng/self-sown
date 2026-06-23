---
name: HeroUI Button as=label swallows file-input clicks
description: A hidden file input opened via HeroUI `Button as="label" htmlFor` often won't open the picker; use a ref + explicit input.click() instead.
---

# File pickers must use ref + explicit click, not `Button as="label"`

To open a hidden `<input type="file">`, do NOT wrap it with a HeroUI
`<Button as="label" htmlFor="...">`. HeroUI Button runs react-aria press
handling, which intercepts/preventDefaults the click, so the native
`label[for]` → input activation is swallowed and the picker frequently never
opens. The upload then silently does nothing.

**Do this instead** (the proven pattern in `file-uploader.tsx`):

- keep a `useRef<HTMLInputElement>` on the hidden input,
- render a normal `<Button type="button" onClick={...}>`,
- in the handler call `hiddenFileInput.current?.click()`.

**Why:** caught when the lab-report (COA) uploader appeared wired correctly
(state → tags → parser → display all fine) but no file ever uploaded, because
the picker never opened. The image uploader worked precisely because it used the
ref+click pattern, not a label.

**Also:** for multi-file support add `multiple` to the input and iterate
`Array.from(event.target.files)`, uploading each in its own try/catch so one bad
file doesn't abort the rest; reset `input.value = ""` in a finally so re-selecting
the same file re-fires onChange.
