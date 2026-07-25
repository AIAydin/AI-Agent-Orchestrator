#include <node_api.h>
#include <aclapi.h>
#include <sddl.h>
#include <windows.h>

#include <cwctype>
#include <cstdint>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

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

bool SidString(PSID sid, std::string* output) {
  if (sid == nullptr || !IsValidSid(sid)) return false;
  LPWSTR value = nullptr;
  if (!ConvertSidToStringSidW(sid, &value) || value == nullptr) return false;
  const int required = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, nullptr, 0,
                                           nullptr, nullptr);
  if (required <= 1) {
    LocalFree(value);
    return false;
  }
  std::string converted(static_cast<size_t>(required), '\0');
  const int written = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1,
                                          converted.data(), required, nullptr, nullptr);
  LocalFree(value);
  if (written != required) return false;
  converted.resize(static_cast<size_t>(required - 1));
  *output = std::move(converted);
  return true;
}

napi_value CurrentUserSid(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  if (napi_get_cb_info(env, info, &argc, nullptr, nullptr, nullptr) != napi_ok || argc != 0) {
    ThrowBounded(env, "ERR_FORGEBOARD_WINDOWS_IDENTITY_INPUT",
                 "Forgeboard rejected the Windows identity request.");
    return nullptr;
  }
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
    ThrowBounded(env, "ERR_FORGEBOARD_WINDOWS_IDENTITY_FAILED",
                 "Forgeboard could not verify the current Windows account.");
    return nullptr;
  }
  DWORD required = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &required);
  std::string sid_value;
  if (required == 0) {
    CloseHandle(token);
    ThrowBounded(env, "ERR_FORGEBOARD_WINDOWS_IDENTITY_FAILED",
                 "Forgeboard could not verify the current Windows account.");
    return nullptr;
  }
  std::vector<std::uintptr_t> buffer(
      (required + sizeof(std::uintptr_t) - 1) / sizeof(std::uintptr_t));
  const bool succeeded =
      GetTokenInformation(token, TokenUser, buffer.data(), required, &required) != FALSE &&
      SidString(reinterpret_cast<TOKEN_USER*>(buffer.data())->User.Sid, &sid_value);
  CloseHandle(token);
  if (!succeeded) {
    ThrowBounded(env, "ERR_FORGEBOARD_WINDOWS_IDENTITY_FAILED",
                 "Forgeboard could not verify the current Windows account.");
    return nullptr;
  }
  napi_value result;
  if (napi_create_string_utf8(env, sid_value.c_str(), sid_value.size(), &result) != napi_ok) {
    ThrowBounded(env, "ERR_FORGEBOARD_WINDOWS_IDENTITY_FAILED",
                 "Forgeboard could not verify the current Windows account.");
    return nullptr;
  }
  return result;
}

napi_value InspectFilesystemAcl(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
    ThrowBounded(env, "ERR_FORGEBOARD_WINDOWS_ACL_INPUT",
                 "Forgeboard rejected the Windows permission request.");
    return nullptr;
  }
  std::wstring path;
  if (!ReadWideString(env, argv[0], &path) || !IsNormalizedAbsoluteWindowsPath(path)) {
    ThrowBounded(env, "ERR_FORGEBOARD_WINDOWS_ACL_INPUT",
                 "Forgeboard rejected the Windows permission request.");
    return nullptr;
  }

  const std::wstring native_path = ExtendedPath(path);
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  PSID owner = nullptr;
  PACL dacl = nullptr;
  const DWORD status = GetNamedSecurityInfoW(
      const_cast<LPWSTR>(native_path.c_str()), SE_FILE_OBJECT,
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, nullptr, &dacl, nullptr,
      &descriptor);
  if (status != ERROR_SUCCESS || descriptor == nullptr) {
    if (descriptor != nullptr) LocalFree(descriptor);
    ThrowBounded(env, "ERR_FORGEBOARD_WINDOWS_ACL_INSPECTION_FAILED",
                 "Forgeboard could not inspect Windows permissions.");
    return nullptr;
  }

  BOOL dacl_present = FALSE;
  BOOL dacl_defaulted = FALSE;
  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0;
  std::string owner_sid;
  if (!GetSecurityDescriptorDacl(descriptor, &dacl_present, &dacl, &dacl_defaulted) ||
      !GetSecurityDescriptorControl(descriptor, &control, &revision) ||
      !SidString(owner, &owner_sid)) {
    LocalFree(descriptor);
    ThrowBounded(env, "ERR_FORGEBOARD_WINDOWS_ACL_INSPECTION_FAILED",
                 "Forgeboard could not inspect Windows permissions.");
    return nullptr;
  }

  bool unsupported = false;
  std::ostringstream rules;
  rules << '[';
  bool first = true;
  if (dacl_present && dacl != nullptr) {
    for (DWORD index = 0; index < dacl->AceCount; ++index) {
      LPVOID raw_ace = nullptr;
      if (!GetAce(dacl, index, &raw_ace) || raw_ace == nullptr) {
        LocalFree(descriptor);
        ThrowBounded(env, "ERR_FORGEBOARD_WINDOWS_ACL_INSPECTION_FAILED",
                     "Forgeboard could not inspect Windows permissions.");
        return nullptr;
      }
      const auto* header = static_cast<ACE_HEADER*>(raw_ace);
      const bool allowed = header->AceType == ACCESS_ALLOWED_ACE_TYPE;
      const bool denied = header->AceType == ACCESS_DENIED_ACE_TYPE;
      if (!allowed && !denied) {
        unsupported = true;
        continue;
      }
      const auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(raw_ace);
      std::string sid;
      if (!SidString(const_cast<DWORD*>(&ace->SidStart), &sid)) {
        LocalFree(descriptor);
        ThrowBounded(env, "ERR_FORGEBOARD_WINDOWS_ACL_INSPECTION_FAILED",
                     "Forgeboard could not inspect Windows permissions.");
        return nullptr;
      }
      const int inheritance =
          ((header->AceFlags & CONTAINER_INHERIT_ACE) != 0 ? 1 : 0) |
          ((header->AceFlags & OBJECT_INHERIT_ACE) != 0 ? 2 : 0);
      const int propagation =
          ((header->AceFlags & NO_PROPAGATE_INHERIT_ACE) != 0 ? 1 : 0) |
          ((header->AceFlags & INHERIT_ONLY_ACE) != 0 ? 2 : 0);
      if (!first) rules << ',';
      first = false;
      rules << "{\"sid\":\"" << sid << "\",\"accessType\":\""
            << (allowed ? "Allow" : "Deny") << "\",\"rights\":"
            << static_cast<unsigned long>(ace->Mask) << ",\"inherited\":"
            << ((header->AceFlags & INHERITED_ACE) != 0 ? "true" : "false")
            << ",\"inheritanceFlags\":" << inheritance << ",\"propagationFlags\":"
            << propagation << '}';
    }
  }
  rules << ']';

  std::ostringstream report;
  report << "{\"schemaVersion\":2,\"ownerSid\":\"" << owner_sid
         << "\",\"daclPresent\":" << (dacl_present && dacl != nullptr ? "true" : "false")
         << ",\"hasUnsupportedDaclAce\":" << (unsupported ? "true" : "false")
         << ",\"protected\":" << ((control & SE_DACL_PROTECTED) != 0 ? "true" : "false")
         << ",\"rules\":" << rules.str() << '}';
  LocalFree(descriptor);
  const std::string serialized = report.str();
  napi_value result;
  if (napi_create_string_utf8(env, serialized.c_str(), serialized.size(), &result) != napi_ok) {
    ThrowBounded(env, "ERR_FORGEBOARD_WINDOWS_ACL_INSPECTION_FAILED",
                 "Forgeboard could not inspect Windows permissions.");
    return nullptr;
  }
  return result;
}

napi_value ProtectFilesystemAcl(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 3) {
    ThrowBounded(env, "ERR_FORGEBOARD_WINDOWS_ACL_INPUT",
                 "Forgeboard rejected the Windows permission request.");
    return nullptr;
  }
  std::wstring path;
  std::wstring user_sid_value;
  bool directory = false;
  if (!ReadWideString(env, argv[0], &path) || !ReadWideString(env, argv[1], &user_sid_value) ||
      !ReadBoolean(env, argv[2], &directory) || !IsNormalizedAbsoluteWindowsPath(path)) {
    ThrowBounded(env, "ERR_FORGEBOARD_WINDOWS_ACL_INPUT",
                 "Forgeboard rejected the Windows permission request.");
    return nullptr;
  }

  PSID user_sid = nullptr;
  BYTE system_sid_buffer[SECURITY_MAX_SID_SIZE];
  DWORD system_sid_size = sizeof(system_sid_buffer);
  if (!ConvertStringSidToSidW(user_sid_value.c_str(), &user_sid) ||
      !CreateWellKnownSid(WinLocalSystemSid, nullptr, system_sid_buffer, &system_sid_size)) {
    if (user_sid != nullptr) LocalFree(user_sid);
    ThrowBounded(env, "ERR_FORGEBOARD_WINDOWS_ACL_INPUT",
                 "Forgeboard rejected the Windows permission request.");
    return nullptr;
  }

  EXPLICIT_ACCESSW entries[2] = {};
  const DWORD inheritance = directory ? SUB_CONTAINERS_AND_OBJECTS_INHERIT : NO_INHERITANCE;
  for (size_t index = 0; index < 2; ++index) {
    entries[index].grfAccessPermissions = FILE_ALL_ACCESS;
    entries[index].grfAccessMode = SET_ACCESS;
    entries[index].grfInheritance = inheritance;
    entries[index].Trustee.TrusteeForm = TRUSTEE_IS_SID;
    entries[index].Trustee.TrusteeType = TRUSTEE_IS_USER;
  }
  entries[0].Trustee.ptstrName = static_cast<LPWSTR>(user_sid);
  entries[1].Trustee.ptstrName = reinterpret_cast<LPWSTR>(system_sid_buffer);

  PACL acl = nullptr;
  const DWORD acl_status = SetEntriesInAclW(2, entries, nullptr, &acl);
  const std::wstring native_path = ExtendedPath(path);
  const DWORD set_status =
      acl_status == ERROR_SUCCESS
          ? SetNamedSecurityInfoW(
                const_cast<LPWSTR>(native_path.c_str()), SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION |
                    PROTECTED_DACL_SECURITY_INFORMATION,
                user_sid, nullptr, acl, nullptr)
          : acl_status;
  if (acl != nullptr) LocalFree(acl);
  LocalFree(user_sid);
  if (set_status != ERROR_SUCCESS) {
    ThrowBounded(env, "ERR_FORGEBOARD_WINDOWS_ACL_PROTECTION_FAILED",
                 "Forgeboard could not protect Windows permissions.");
    return nullptr;
  }

  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
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
  struct Export {
    const char* name;
    napi_callback callback;
  };
  const Export functions[] = {
      {"currentUserSid", CurrentUserSid},
      {"inspectFilesystemAcl", InspectFilesystemAcl},
      {"moveFileWriteThrough", MoveFileWriteThrough},
      {"protectFilesystemAcl", ProtectFilesystemAcl},
  };
  for (const auto& exported : functions) {
    napi_value function;
    if (napi_create_function(env, exported.name, NAPI_AUTO_LENGTH, exported.callback, nullptr,
                             &function) != napi_ok ||
        napi_set_named_property(env, exports, exported.name, function) != napi_ok) {
      ThrowBounded(env, "ERR_FORGEBOARD_DURABLE_MOVE_INIT",
                   "Forgeboard could not initialize Windows durable filesystem support.");
      return nullptr;
    }
  }
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
