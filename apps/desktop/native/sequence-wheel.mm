#import <AppKit/AppKit.h>
#include <node_api.h>
#include <cstring>

@interface DNAForgeWheelWindow : NSObject
@property(nonatomic, weak) NSView *view;
@property(nonatomic) NSUInteger seen;
@property(nonatomic) NSUInteger suppressed;
@property(nonatomic) NSUInteger mouseForwarded;
@property(nonatomic) NSUInteger preciseForwarded;
@property(nonatomic) NSUInteger ordinal;
@property(nonatomic) NSEventPhase lastPhase;
@property(nonatomic) NSEventPhase lastMomentum;
@property(nonatomic) NSEventModifierFlags lastModifiers;
@end
@implementation DNAForgeWheelWindow
@end

static NSMutableDictionary<NSNumber *, DNAForgeWheelWindow *> *windows;
static id monitor;
static BOOL diagnosticsEnabled;
static napi_env inputEnv;
static napi_ref mouseHandler;
static napi_async_context mouseContext;

static void ObserveWheel(DNAForgeWheelWindow *state, NSEvent *event) {
  if (!mouseHandler) return;
  napi_handle_scope scope;
  if (napi_open_handle_scope(inputEnv, &scope) != napi_ok) return;
  napi_value fn, receiver, args[6], result;
  napi_get_reference_value(inputEnv, mouseHandler, &fn);
  napi_get_global(inputEnv, &receiver);
  const double timestamp = NSDate.date.timeIntervalSince1970 * 1000 -
      (NSProcessInfo.processInfo.systemUptime - event.timestamp) * 1000;
  const double values[] = {(double)event.window.windowNumber, (double)event.phase,
      (double)event.momentumPhase, (double)++state.ordinal, timestamp};
  napi_create_double(inputEnv, values[0], &args[0]);
  napi_get_boolean(inputEnv, event.hasPreciseScrollingDeltas, &args[1]);
  for (int i = 1; i < 5; i++) napi_create_double(inputEnv, values[i], &args[i + 1]);
  napi_make_callback(inputEnv, mouseContext, receiver, fn, 6, args, &result);
  napi_close_handle_scope(inputEnv, scope);
  if (diagnosticsEnabled) {
    state.seen++;
    state.lastPhase = event.phase;
    state.lastMomentum = event.momentumPhase;
    state.lastModifiers = event.modifierFlags;
    if (event.hasPreciseScrollingDeltas) state.preciseForwarded++;
    else state.mouseForwarded++;
  }
}

static NSEvent *FilterWheel(NSEvent *event) {
  DNAForgeWheelWindow *state = windows[@(event.window.windowNumber)];
  if (state.view) ObserveWheel(state, event);
  return event;
}

static napi_value Undefined(napi_env env) {
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static DNAForgeWheelWindow *WindowForToken(napi_env env, napi_value value) {
  int32_t token;
  if (napi_get_value_int32(env, value, &token) != napi_ok) {
    napi_throw_type_error(env, nullptr, "Expected a native window token");
    return nil;
  }
  return windows[@(token)];
}

static napi_value TrackWindow(napi_env env, napi_callback_info info) {
  napi_value arg;
  size_t argc = 1;
  napi_get_cb_info(env, info, &argc, &arg, nullptr, nullptr);
  void *data = nullptr;
  size_t length = 0;
  if (argc != 1 || napi_get_buffer_info(env, arg, &data, &length) != napi_ok ||
      length != sizeof(void *)) {
    napi_throw_type_error(env, nullptr, "Expected an Electron native view handle");
    return nullptr;
  }
  void *pointer;
  std::memcpy(&pointer, data, sizeof(pointer));
  NSView *view = (__bridge NSView *)pointer;
  if (![view isKindOfClass:[NSView class]] || !view.window) {
    napi_throw_error(env, nullptr, "The Electron native view has no window");
    return nullptr;
  }
  if (!windows) windows = [NSMutableDictionary new];
  DNAForgeWheelWindow *state = [DNAForgeWheelWindow new];
  state.view = view;
  windows[@(view.window.windowNumber)] = state;
  if (!monitor)
    monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskScrollWheel
                                                   handler:^NSEvent *(NSEvent *event) {
                                                     return FilterWheel(event);
                                                   }];
  napi_value result;
  napi_create_int32(env, (int32_t)view.window.windowNumber, &result);
  return result;
}

static napi_value RemoveWindow(napi_env env, napi_callback_info info) {
  napi_value arg;
  size_t argc = 1;
  napi_get_cb_info(env, info, &argc, &arg, nullptr, nullptr);
  int32_t token;
  if (argc != 1 || napi_get_value_int32(env, arg, &token) != napi_ok) {
    napi_throw_type_error(env, nullptr, "Expected a native window token");
    return nullptr;
  }
  [windows removeObjectForKey:@(token)];
  return Undefined(env);
}

static napi_value SetMouseHandler(napi_env env, napi_callback_info info) {
  napi_value callback;
  size_t argc = 1;
  napi_get_cb_info(env, info, &argc, &callback, nullptr, nullptr);
  napi_valuetype type;
  if (argc != 1 || napi_typeof(env, callback, &type) != napi_ok || type != napi_function) {
    napi_throw_type_error(env, nullptr, "Expected a sequence-wheel handler");
    return nullptr;
  }
  if (mouseHandler) napi_delete_reference(inputEnv, mouseHandler);
  if (mouseContext) napi_async_destroy(inputEnv, mouseContext);
  inputEnv = env;
  napi_create_reference(env, callback, 1, &mouseHandler);
  napi_value name;
  napi_create_string_utf8(env, "DNAForge ordered sequence wheel", NAPI_AUTO_LENGTH, &name);
  napi_async_init(env, nullptr, name, &mouseContext);
  return Undefined(env);
}

static void Cleanup(void *) {
  if (monitor) [NSEvent removeMonitor:monitor];
  monitor = nil;
  windows = nil;
  if (mouseHandler) napi_delete_reference(inputEnv, mouseHandler);
  if (mouseContext) napi_async_destroy(inputEnv, mouseContext);
  mouseHandler = nullptr;
  mouseContext = nullptr;
}

static napi_value Diagnostics(napi_env env, napi_callback_info info) {
  diagnosticsEnabled = YES;
  napi_value result;
  napi_create_array(env, &result);
  uint32_t index = 0;
  for (NSNumber *token in windows) {
    DNAForgeWheelWindow *state = windows[token];
    napi_value row;
    napi_create_object(env, &row);
    const char *keys[] = {"token", "seen", "suppressed", "phase", "momentum", "modifiers", "consumed", "mouseForwarded", "preciseForwarded", "ordinal"};
    const double values[] = {token.doubleValue, (double)state.seen, (double)state.suppressed, (double)state.lastPhase, (double)state.lastMomentum, (double)state.lastModifiers, 0, (double)state.mouseForwarded, (double)state.preciseForwarded, (double)state.ordinal};
    for (int i = 0; i < 10; i++) {
      napi_value value;
      napi_create_double(env, values[i], &value);
      napi_set_named_property(env, row, keys[i], value);
    }
    napi_set_element(env, result, index++, row);
  }
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  const napi_property_descriptor methods[] = {
      {"trackWindow", nullptr, TrackWindow, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"removeWindow", nullptr, RemoveWindow, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"setMouseHandler", nullptr, SetMouseHandler, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"diagnostics", nullptr, Diagnostics, nullptr, nullptr, nullptr, napi_default, nullptr}};
  napi_define_properties(env, exports, 4, methods);
  napi_add_env_cleanup_hook(env, Cleanup, nullptr);
  return exports;
}
NAPI_MODULE(sequence_wheel, Init)
