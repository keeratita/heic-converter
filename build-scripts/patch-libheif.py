import os
import sys

def main():
    candidate_paths = [
        'build-wasm/src/libheif/libheif/context.cc',
        'libheif/libheif/context.cc',
        'src/libheif/libheif/context.cc'
    ]
    filepath = None
    for path in candidate_paths:
        if os.path.exists(path):
            filepath = path
            break

    if not filepath:
        print("Warning: libheif context.cc not found. It will be patched when the file exists.", file=sys.stderr)
        return

    with open(filepath, 'r') as f:
        content = f.read()

    if 'options.start_progress' in content:
        print("libheif context.cc is already patched for progress callbacks.")
        return

    print("Patching libheif context.cc for progress callbacks...")

    # 1. Patch start_progress callback before the loop
    target_start = 'uint32_t tile_width=0;'
    replacement_start = (
        'if (options.start_progress) {\n'
        '    options.start_progress(heif_progress_step_load_tile, grid.get_rows() * grid.get_columns(), options.progress_user_data);\n'
        '  }\n  uint32_t tile_width=0;'
    )
    if target_start not in content:
        print("Error: Could not find target_start signature in context.cc", file=sys.stderr)
        sys.exit(1)
    content = content.replace(target_start, replacement_start, 1)

    # 2. Patch on_progress callback inside the loop
    target_on = (
        '        err = decode_and_paste_tile_image(tileID, img, x0, y0, options);\n'
        '        if (err) {\n'
        '          return err;\n'
        '        }'
    )
    replacement_on = (
        '        err = decode_and_paste_tile_image(tileID, img, x0, y0, options);\n'
        '        if (err) {\n'
        '          return err;\n'
        '        }\n'
        '        if (options.on_progress) {\n'
        '          options.on_progress(heif_progress_step_load_tile, reference_idx + 1, options.progress_user_data);\n'
        '        }'
    )
    if target_on not in content:
        print("Error: Could not find target_on signature in context.cc", file=sys.stderr)
        sys.exit(1)
    content = content.replace(target_on, replacement_on, 1)

    # 3. Patch end_progress callback at the end of decode_full_grid_image
    # We locate the specific `return Error::Ok;` right before `Error HeifContext::decode_and_paste_tile_image`
    target_end = (
        '  return Error::Ok;\n'
        '}\n'
        '\n'
        '\n'
        'Error HeifContext::decode_and_paste_tile_image'
    )
    replacement_end = (
        '  if (options.end_progress) {\n'
        '    options.end_progress(heif_progress_step_load_tile, options.progress_user_data);\n'
        '  }\n'
        '  return Error::Ok;\n'
        '}\n'
        '\n'
        '\n'
        'Error HeifContext::decode_and_paste_tile_image'
    )
    if target_end not in content:
        print("Error: Could not find target_end signature in context.cc", file=sys.stderr)
        sys.exit(1)
    content = content.replace(target_end, replacement_end, 1)

    with open(filepath, 'w') as f:
        f.write(content)
    print("Successfully patched context.cc!")

if __name__ == '__main__':
    main()
