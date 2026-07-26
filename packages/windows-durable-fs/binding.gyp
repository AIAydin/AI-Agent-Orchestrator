{
  "targets": [
    {
      "target_name": "forgeboard_windows_durable_fs",
      "sources": ["native/move_file.cc"],
      "defines": ["NAPI_VERSION=8"],
      "conditions": [
        ["OS=='win'", { "libraries": ["Advapi32.lib", "Kernel32.lib"] }],
        ["OS!='win'", { "type": "none" }]
      ]
    }
  ]
}
