#import <AppKit/AppKit.h>
#include <node_api.h>
#include <cstring>

@interface DNAForgeWheelWindow : NSObject
@property(nonatomic, weak) NSView *view;
@property(nonatomic, strong) NSArray<NSValue *> *regions;
@property(nonatomic) BOOL zoomOwnsGesture;
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

// All admitted sequence packets have one ordered owner. Mixing discrete IPC
// with Chromium precision delivery lets a newer mouse tick overtake an older
// finger packet. Consume only after handing the packet to that window's FIFO.
static BOOL ForwardSequenceWheel(DNAForgeWheelWindow *state, NSEvent *event, NSPoint point) {
  if (!mouseHandler) return NO;
  napi_handle_scope scope;
  if (napi_open_handle_scope(inputEnv, &scope) != napi_ok) return NO;
  napi_value fn, receiver, args[10], result;
  napi_get_reference_value(inputEnv, mouseHandler, &fn);
  napi_get_global(inputEnv, &receiver);
  const BOOL precise = event.hasPreciseScrollingDeltas;
  const NSUInteger ordinal = state.ordinal + 1;
  const double values[] = {(double)event.window.windowNumber, point.x, point.y,
                           precise ? -event.scrollingDeltaX : -40.0 * event.deltaX,
                           precise ? -event.scrollingDeltaY : -40.0 * event.deltaY,
                           (double)event.modifierFlags};
  for (int i = 0; i < 6; i++) napi_create_double(inputEnv, values[i], &args[i]);
  napi_get_boolean(inputEnv, precise, &args[6]);
  napi_create_double(inputEnv, (double)event.phase, &args[7]);
  napi_create_double(inputEnv, (double)event.momentumPhase, &args[8]);
  napi_create_double(inputEnv, (double)ordinal, &args[9]);
  const napi_status status = napi_make_callback(inputEnv, mouseContext, receiver, fn, 10, args, &result);
  bool delivered = false;
  if (status == napi_ok) napi_get_value_bool(inputEnv, result, &delivered);
  napi_close_handle_scope(inputEnv, scope);
  if (delivered) {
    state.ordinal = ordinal;
    if (diagnosticsEnabled) {
      if (precise) state.preciseForwarded++;
      else state.mouseForwarded++;
    }
  }
  return delivered;
}

// This runs in AppKit before Chromium queues/delivers the event. Ownership is
// a gesture property, not a guess based on packet size or elapsed time.
static NSEvent *FilterWheel(NSEvent *event) {
  DNAForgeWheelWindow *state = windows[@(event.window.windowNumber)];
  NSView *view = state.view;
  if (!view) return event;
  const NSEventPhase phase = event.phase;
  const NSEventPhase momentum = event.momentumPhase;
  const BOOL begins = (phase & (NSEventPhaseBegan | NSEventPhaseMayBegin)) != 0;
  const BOOL unphased = phase == NSEventPhaseNone && momentum == NSEventPhaseNone;
  NSPoint point = [view convertPoint:event.locationInWindow fromView:nil];
  if (!view.isFlipped) point.y = view.bounds.size.height - point.y;
  BOOL overViewport = NO;
  for (NSValue *region in state.regions)
    if (NSPointInRect(point, region.rectValue)) { overViewport = YES; break; }
  const BOOL zoomModifier =
      (event.modifierFlags & (NSEventModifierFlagCommand | NSEventModifierFlagControl)) != 0 &&
      (event.modifierFlags & NSEventModifierFlagShift) == 0;
  if (begins || unphased) state.zoomOwnsGesture = NO;
  if (overViewport && zoomModifier && event.scrollingDeltaY != 0)
    state.zoomOwnsGesture = YES;
  const BOOL suppress = state.zoomOwnsGesture && !zoomModifier;
  if (diagnosticsEnabled) {
    state.seen++;
    if (suppress) state.suppressed++;
    state.lastPhase = phase;
    state.lastMomentum = momentum;
    state.lastModifiers = event.modifierFlags;
  }
  // Finger end is followed by momentum, so it must retain its owner. Only
  // momentum end/cancel or a new physical gesture releases that ownership.
  if ((momentum & (NSEventPhaseEnded | NSEventPhaseCancelled)) != 0 ||
      (phase & NSEventPhaseCancelled) != 0)
    state.zoomOwnsGesture = NO;
  if (suppress) return nil;
  // Admission keeps the existing native location/region boundary. AppKit owns
  // the NSWindow momentum target; we do not manufacture or retarget that latch.
  // Shift and packets outside sequence regions retain their Chromium route.
  if (overViewport &&
      (event.modifierFlags & NSEventModifierFlagShift) == 0 &&
      ForwardSequenceWheel(state, event, point)) return nil;
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

static napi_value SetZoomRegion(napi_env env, napi_callback_info info) {
  napi_value args[2];
  size_t argc = 2;
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 2) {
    napi_throw_type_error(env, nullptr, "Expected window token and viewport region");
    return nullptr;
  }
  DNAForgeWheelWindow *state = WindowForToken(env, args[0]);
  if (!state) return Undefined(env);
  uint32_t length;
  if (napi_get_array_length(env, args[1], &length) != napi_ok) {
    napi_throw_type_error(env, nullptr, "Expected viewport regions");
    return nullptr;
  }
  NSMutableArray<NSValue *> *regions = [NSMutableArray new];
  const char *names[] = {"x", "y", "width", "height"};
  for (uint32_t r = 0; r < length; r++) {
    napi_value region;
    napi_get_element(env, args[1], r, &region);
    double values[4];
    for (int i = 0; i < 4; i++) {
      napi_value value;
      if (napi_get_named_property(env, region, names[i], &value) != napi_ok ||
        napi_get_value_double(env, value, &values[i]) != napi_ok) {
        napi_throw_type_error(env, nullptr, "Invalid viewport region");
        return nullptr;
      }
    }
    [regions addObject:[NSValue valueWithRect:NSMakeRect(values[0], values[1], values[2], values[3])]];
  }
  state.regions = regions;
  return Undefined(env);
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

// Read-only, bounded diagnostics for native acceptance. Recording is off
// until explicitly read by the main-process test driver; no per-event IPC.
static napi_value Diagnostics(napi_env env, napi_callback_info info) {
  diagnosticsEnabled = YES;
  napi_value result;
  napi_create_array(env, &result);
  uint32_t index = 0;
  for (NSNumber *token in windows) {
    DNAForgeWheelWindow *state = windows[token];
    napi_value row;
    napi_create_object(env, &row);
    const char *keys[] = {"token", "seen", "suppressed", "phase", "momentum", "modifiers", "zoomOwnsGesture", "regions", "mouseForwarded", "preciseForwarded", "ordinal"};
    const double values[] = {token.doubleValue, (double)state.seen, (double)state.suppressed, (double)state.lastPhase, (double)state.lastMomentum, (double)state.lastModifiers, (double)state.zoomOwnsGesture, (double)state.regions.count, (double)state.mouseForwarded, (double)state.preciseForwarded, (double)state.ordinal};
    for (int i = 0; i < 11; i++) {
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
      {"setZoomRegion", nullptr, SetZoomRegion, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"removeWindow", nullptr, RemoveWindow, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"setMouseHandler", nullptr, SetMouseHandler, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"diagnostics", nullptr, Diagnostics, nullptr, nullptr, nullptr, napi_default, nullptr}};
  napi_define_properties(env, exports, 5, methods);
  napi_add_env_cleanup_hook(env, Cleanup, nullptr);
  return exports;
}
NAPI_MODULE(sequence_wheel, Init)
