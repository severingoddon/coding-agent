// Mac → sandbox clipboard bridge for images (runs during pidev, via osascript -l JavaScript).
// If the clipboard holds an image (screenshot, copied image, image file in Finder),
// it is written as PNG to <dir>/clip.png, otherwise clip.png is deleted.
// Exits by itself when no pidev session is left (also after a crash or a closed terminal).
ObjC.import("AppKit");

function run(argv) {
  const out = argv[0] + "/clip.png";
  const pb = $.NSPasteboard.generalPasteboard;
  const fm = $.NSFileManager.defaultManager;
  const IMG_EXT = ["png", "jpg", "jpeg", "gif", "webp", "heic", "tiff", "bmp"];
  let last = -1;
  const app = Application.currentApplication();
  app.includeStandardAdditions = true;
  const pidevRunning = () =>
    app.doShellScript('pgrep -f "^openshell sandbox create --name pi-" >/dev/null && echo 1 || echo 0') === "1";

  function clear() {
    if (fm.fileExistsAtPath(out)) fm.removeItemAtPathError(out, null);
  }

  function currentImage() {
    const types = ObjC.deepUnwrap(pb.types) || [];
    if (types.includes("public.file-url")) {
      const url = $.NSURL.URLWithString(pb.stringForType("public.file-url"));
      const ext = ObjC.unwrap(url.pathExtension).toLowerCase();
      return IMG_EXT.includes(ext) ? $.NSImage.alloc.initWithContentsOfURL(url) : null;
    }
    const hasImage = types.some((t) => ["public.png", "public.tiff", "public.jpeg"].includes(t));
    const isRichText = types.some((t) => t === "public.rtf" || t === "com.apple.flat-rtfd");
    return hasImage && !isRichText ? $.NSImage.alloc.initWithPasteboard(pb) : null;
  }

  function update() {
    const img = currentImage();
    if (!img || img.isNil()) return clear();
    const rep = $.NSBitmapImageRep.imageRepWithData(img.TIFFRepresentation);
    if (rep.isNil()) return clear();
    const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
    png.writeToFileAtomically(out, true);
  }

  for (let tick = 1; ; tick++) {
    if (tick % 25 === 0 && !pidevRunning()) return clear(); // check every ~10 s
    const c = pb.changeCount;
    if (c !== last) {
      last = c;
      try { update(); } catch (e) { clear(); }
    }
    delay(0.4);
  }
}
