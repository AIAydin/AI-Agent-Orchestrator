#include <node_api.h>
#include <windows.h>

#include <cwctype>
#include <string>

namespace {

constexpr size_t kMaximumPathCharacters = 32767;

void ThrowBounded(napi_env env, const char* code, const char* message) {
  napi_throw_error(env, code, message);
}

bool ReadBoolean(napi_env env, napi_value value, bool* output) {
  bool parsed = false;
  if (napi_get_value_bool(env, value, &parsed) != napi_ok) return false;
  *output = parsed;
  return true;
}

bool ReadWideString(napi_env env, napi_value value, std::wstring* output) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return false;
  size_t length = 0;
  if (napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok ||
      length == 0 || length > kMaximumPathCharacters) {
    return false;
  }
  std::u16string utf16(length + 1, u'\0');
  size_t written = 0;
  if (napi_get_value_string_utf16(env, value, reinterpret_cast<char16_t*>(utf16.data()),
                                  length + 1, &written) != napi_ok ||
      written != length) {
    return false;
  }
  output->assign(reinterpret_cast<const wchar_t*>(utf16.data()), written);
  return output->find(L'\0') == std::wstring::npos;
}

bool IsNormalizedAbsoluteWindowsPath(const std::wstring& path) {
  if (path.find(L'/') != std::wstring::npos) return false;
  const bool drive_absolute = path.size() >= 3 && std::iswalpha(path[0]) && path[1] == L':' &&
                              path[2] == L'\\';
  const bool unc_absolute = path.size() >= 5 && path[0] == L'\\' && path[1] == L'\\' &&
                            path[2] != L'\\';
  if (!drive_absolute && !unc_absolute) return false;

  size_t component_start = drive_absolute ? 3 : 2;
  size_t component_count = 0;
  while (component_start <= path.size()) {
    const size_t separator = path.find(L'\\', component_start);
    const size_t component_end = separator == std::wstring::npos ? path.size() : separator;
    const std::wstring component = path.substr(component_start, component_end - component_start);
    if (component.empty() || component == L"." || component == L".." ||
        component.find_first_of(L"<>:\"|?*") != std::wstring::npos ||
        component.back() == L' ' || component.back() == L'.') {
      return false;
    }
    component_count += 1;
    if (separator == std::wstring::npos) break;
    component_start = separator + 1;
  }
  return drive_absolute ? component_count >= 1 : component_count >= 2;
}

std::wstring ExtendedPath(const std::wstring& path) {
  if (path.rfind(L"\\\\?\\", 0) == 0) return path;
  if (path.rfind(L"\\\\", 0) == 0) return L"\\\\?\\UNC\\" + path.substr(2);
  return L"\\\\?\\" + path;
}

napi_value MoveFileWriteThrough(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 3) {
    ThrowBounded(env, "ERR_FORGEBOARD_DURABLE_MOVE_INPUT",
                 "Forgeboard rejected the Windows durable move request.");
    return nullptr;
  }

  std::wstring source;
  std::wstring destination;
  bool replace_existing = false;
  if (!ReadWideString(env, argv[0], &source) || !ReadWideString(env, argv[1], &destination) ||
      !ReadBoolean(env, argv[2], &replace_existing) ||
      !IsNormalizedAbsoluteWindowsPath(source) ||
      !IsNormalizedAbsoluteWindowsPath(destination) || _wcsicmp(source.c_str(), destination.c_str()) == 0) {
    ThrowBounded(env, "ERR_FORGEBOARD_DURABLE_MOVE_INPUT",
                 "Forgeboard rejected the Windows durable move request.");
    return nullptr;
  }

  const std::wstring native_source = ExtendedPath(source);
  const std::wstring native_destination = ExtendedPath(destination);
  const DWORD flags = MOVEFILE_WRITE_THROUGH |
                      (replace_existing ? MOVEFILE_REPLACE_EXISTING : 0);
  if (!MoveFileExW(native_source.c_str(), native_destination.c_str(), flags)) {
    ThrowBounded(env, "ERR_FORGEBOARD_DURABLE_MOVE_FAILED",
                 "Forgeboard could not complete the durable Windows move.");
    return nullptr;
  }

  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

napi_value Initialize(napi_env env, napi_value exports) {
  napi_value function;
  if (napi_create_function(env, "moveFileWriteThrough", NAPI_AUTO_LENGTH,
                           MoveFileWriteThrough, nullptr, &function) != napi_ok ||
      napi_set_named_property(env, exports, "moveFileWriteThrough", function) != napi_ok) {
    ThrowBounded(env, "ERR_FORGEBOARD_DURABLE_MOVE_INIT",
                 "Forgeboard could not initialize Windows durable filesystem support.");
    return nullptr;
  }
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
