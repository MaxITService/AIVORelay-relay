# ChatGPT file upload (MCP)

This is confirmed on the logged-out landing page (https://chatgpt.com/). The composer exists without login and supports attaching images.

Working method (menu item + upload_file)
1) Take a snapshot.
2) Click the "Add photos" button to open the attach menu.
3) In the menu, click "Images".
4) Call MCP upload_file targeting the menu item element labeled "Images" (the UID varies per session).
5) Verify upload: the composer shows buttons "Edit image" and "Remove file".

Why this bypasses the Windows file picker
- MCP upload_file sets the file directly on the underlying input element, so the OS picker does not remain open or block the flow.

DOM/selector notes (from the landing page HTML)
- The attach button is a <button> with aria-label "Add photos" and visible label "Attach".
- The attach menu contains menuitems: "Connect apps Login required", "Documents Login required", "Images".
- Hidden file inputs exist in the DOM with accept filters for images. Example inputs seen:
  - <input id="upload-photos" class="sr-only" accept="image/*">
  - <input id="upload-camera" class="sr-only" accept="image/*">
  - Another hidden <input type="file"> with accept: image/png,.png,image/gif,.gif,image/jpeg,.jpg,.jpeg,image/webp,.webp
- These inputs were not exposed in the a11y snapshot, so the stable MCP path is using the "Images" menu item UID.

MCP commands used (high level)
- take_snapshot
- click ("Add photos")
- click (menuitem "Images")
- upload_file (uid of menuitem "Images", filePath to local image)

Verification cues in snapshot
- After upload: buttons "Edit image" and "Remove file" appear in the composer area.

Example file path
- C:\Code\AIVORelay-relay\demo-image.png
