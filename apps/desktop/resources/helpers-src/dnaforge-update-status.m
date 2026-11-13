// This window observes the existing signed native updater. It never replaces,
// deletes, downloads, or launches an application and cannot cancel installation.
#import <AppKit/AppKit.h>
#import <fcntl.h>
#import <unistd.h>

typedef struct {
  NSWindowStyleMask style;
  NSWindowCollectionBehavior collection;
  NSInteger level;
} WindowPolicy;

static WindowPolicy windowPolicy(BOOL background) {
  return (WindowPolicy){
    NSWindowStyleMaskTitled | NSWindowStyleMaskFullSizeContentView |
      (background ? NSWindowStyleMaskClosable : 0),
    background ? NSWindowCollectionBehaviorDefault :
      NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary,
    background ? NSNormalWindowLevel - 1 : NSFloatingWindowLevel
  };
}

static void record(NSString *kind, NSDictionary *extra) {
  NSMutableDictionary *entry = [@{ @"kind": kind,
    @"at": @((long long)(NSDate.date.timeIntervalSince1970 * 1000)),
    @"pid": @(getpid()) } mutableCopy];
  [entry addEntriesFromDictionary:extra ?: @{}];
  NSData *json = [NSJSONSerialization dataWithJSONObject:entry options:0 error:nil];
  // Main supplies an already opened, exclusively created, profile-owned file.
  if (json) {
    NSMutableData *line = [json mutableCopy];
    [line appendBytes:"\n" length:1];
    write(3, line.bytes, line.length);
  }
}

static NSString *bootTail(NSString *path) {
  NSFileHandle *file = [NSFileHandle fileHandleForReadingAtPath:path];
  if (!file) return @"";
  @try {
    unsigned long long size = [file seekToEndOfFile];
    [file seekToFileOffset:size > 65536 ? size - 65536 : 0];
    NSData *data = [file readDataToEndOfFile];
    return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"";
  } @catch (NSException *exception) { return @""; }
  @finally { [file closeFile]; }
}

@interface UpdateStatus : NSObject <NSApplicationDelegate, NSWindowDelegate>
@property NSWindow *window;
@property NSTextField *heading;
@property NSImageView *icon;
@property NSTextField *detail;
@property NSProgressIndicator *progress;
@property NSTimer *timer;
@property NSString *bundlePath;
@property NSString *bootPath;
@property NSString *version;
@property NSDate *requested;
@property BOOL background;
@property BOOL opening;
@property BOOL stalled;
@end

@implementation UpdateStatus
- (void)layoutWindow {
  CGFloat height = self.detail.hidden ? 128 : 184;
  [self.window setContentSize:NSMakeSize(360, height)];
  self.icon.frame = NSMakeRect(24, height - 84, 48, 48);
  self.heading.frame = NSMakeRect(96, height - 56, 240, 24);
  self.progress.frame = NSMakeRect(96, height - 84, 240, 16);
  self.detail.frame = NSMakeRect(24, 20, 312, 60);
}
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  WindowPolicy policy = windowPolicy(self.background);
  self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(200, 200, 360, 128)
    styleMask:policy.style
    backing:NSBackingStoreBuffered defer:NO];
  self.window.title = @"Updating DNAForge";
  self.window.delegate = self;
  self.window.releasedWhenClosed = NO;
  self.window.titleVisibility = NSWindowTitleHidden;
  self.window.titlebarAppearsTransparent = YES;
  self.icon = [[NSImageView alloc] initWithFrame:NSZeroRect];
  NSDictionary *info = [NSDictionary dictionaryWithContentsOfFile:
    [self.bundlePath stringByAppendingPathComponent:@"Contents/Info.plist"]];
  NSString *iconResource = info[@"CFBundleIconFile"];
  if ([iconResource isKindOfClass:NSString.class] && iconResource.length &&
      [iconResource isEqualToString:iconResource.lastPathComponent]) {
    NSString *iconFile = iconResource.pathExtension.length ? iconResource :
      [iconResource stringByAppendingPathExtension:@"icns"];
    NSString *resources = [self.bundlePath stringByAppendingPathComponent:@"Contents/Resources"];
    self.icon.image = [[NSImage alloc] initWithContentsOfFile:
      [resources stringByAppendingPathComponent:iconFile]];
  }
  self.icon.imageScaling = NSImageScaleProportionallyUpOrDown;
  [self.window.contentView addSubview:self.icon];
  self.heading = [NSTextField labelWithString:@"Updating DNAForge"];
  self.heading.font = [NSFont systemFontOfSize:16 weight:NSFontWeightSemibold];
  [self.window.contentView addSubview:self.heading];
  self.detail = [NSTextField wrappingLabelWithString:@""];
  self.detail.font = [NSFont systemFontOfSize:13];
  self.detail.textColor = NSColor.secondaryLabelColor;
  self.detail.hidden = YES;
  [self.window.contentView addSubview:self.detail];
  self.progress = [[NSProgressIndicator alloc] initWithFrame:NSZeroRect];
  self.progress.indeterminate = YES;
  self.progress.style = NSProgressIndicatorStyleBar;
  [self.progress startAnimation:nil];
  [self.window.contentView addSubview:self.progress];
  [self layoutWindow];
  self.window.level = policy.level;
  self.window.collectionBehavior = policy.collection;
  if (self.background) {
    [self.window orderBack:nil];
  } else {
    [self.window center];
    [self.window orderFrontRegardless];
  }
  record(@"shown", @{ @"visible": @(self.window.visible), @"window": @(self.window.windowNumber),
    @"title": self.window.title, @"background": @(self.background),
    @"heading": self.heading.stringValue, @"detailVisible": @((BOOL)!self.detail.hidden),
    @"appIcon": @((BOOL)(self.icon.image != nil)),
    @"titleBarTextVisible": @((BOOL)(self.window.titleVisibility != NSWindowTitleHidden)),
    @"contentWidth": @(self.window.contentView.bounds.size.width),
    @"contentHeight": @(self.window.contentView.bounds.size.height),
    @"level": @(self.window.level),
    @"allSpaces": @((BOOL)((self.window.collectionBehavior & NSWindowCollectionBehaviorCanJoinAllSpaces) != 0)),
    @"fullScreenAuxiliary": @((BOOL)((self.window.collectionBehavior & NSWindowCollectionBehaviorFullScreenAuxiliary) != 0)),
    @"closeButton": @((BOOL)((self.window.styleMask & NSWindowStyleMaskClosable) != 0)),
    @"frame": NSStringFromRect(self.window.frame),
    @"display": self.window.screen.deviceDescription[@"NSScreenNumber"] ?: @0 });
  self.timer = [NSTimer scheduledTimerWithTimeInterval:0.25 target:self
    selector:@selector(check:) userInfo:nil repeats:YES];
}
- (void)check:(NSTimer *)timer {
  NSDictionary *info = [NSDictionary dictionaryWithContentsOfFile:
    [self.bundlePath stringByAppendingPathComponent:@"Contents/Info.plist"]];
  if (!self.opening && [info[@"CFBundleShortVersionString"] isEqualToString:self.version]) {
    self.opening = YES;
    if (self.stalled) self.stalled = NO;
    self.heading.stringValue = @"Opening DNAForge";
    self.detail.hidden = YES;
    [self layoutWindow];
    [self.progress startAnimation:nil];
    record(@"opening", @{ @"visible": @(self.window.visible), @"heading": self.heading.stringValue,
      @"detailVisible": @((BOOL)!self.detail.hidden) });
  }
  NSString *boot = [[bootTail(self.bootPath) componentsSeparatedByString:@"# DNAForge"] lastObject];
  NSArray *states = [boot componentsSeparatedByString:@" sidecar_status="];
  NSString *service = [[states.lastObject componentsSeparatedByCharactersInSet:
    NSCharacterSet.whitespaceAndNewlineCharacterSet] firstObject];
  NSArray *loads = [boot componentsSeparatedByString:@" renderer_load_started load="];
  NSArray *acknowledgements = [boot componentsSeparatedByString:@" renderer_shell_ready load="];
  NSString *load = [[loads.lastObject componentsSeparatedByCharactersInSet:
    NSCharacterSet.whitespaceAndNewlineCharacterSet] firstObject];
  NSString *readyLoad = [[acknowledgements.lastObject componentsSeparatedByCharactersInSet:
    NSCharacterSet.whitespaceAndNewlineCharacterSet] firstObject];
  BOOL shellReady = loads.count > 1 && acknowledgements.count > 1 &&
    [load isEqualToString:readyLoad];
  NSRange invalidated = [boot rangeOfString:@" renderer_shell_invalidated " options:NSBackwardsSearch];
  NSRange acknowledged = [boot rangeOfString:@" renderer_shell_ready " options:NSBackwardsSearch];
  if (invalidated.location != NSNotFound &&
      (acknowledged.location == NSNotFound || invalidated.location > acknowledged.location)) {
    shellReady = NO;
  }
  NSRegularExpression *header = [NSRegularExpression regularExpressionWithPattern:
    @"main-boot\\.log schema=1 started=(\\S+) version=(\\S+)" options:0 error:nil];
  NSTextCheckingResult *match = [header firstMatchInString:boot options:0 range:NSMakeRange(0, boot.length)];
  if (match) {
    NSString *version = [boot substringWithRange:[match rangeAtIndex:2]];
    NSISO8601DateFormatter *dates = [NSISO8601DateFormatter new];
    dates.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
    NSDate *started = [dates dateFromString:[boot substringWithRange:[match rangeAtIndex:1]]];
    if ([version isEqualToString:self.version] && started &&
        [started compare:self.requested] != NSOrderedAscending &&
        shellReady &&
        states.count > 1 && [service isEqualToString:@"ready"]) {
      record(@"ready", @{ @"visible": @(self.window.visible), @"version": version });
      [NSApp terminate:nil];
      return;
    }
  }
  if (!self.stalled && [NSDate.date timeIntervalSinceDate:self.requested] > 90) {
    self.stalled = YES;
    [self.progress stopAnimation:nil];
    self.detail.stringValue = self.opening
      ? @"Open DNAForge to continue."
      : @"Taking longer than usual.";
    self.detail.hidden = NO;
    // Dismissing a stalled observer never cancels or touches the installer.
    self.window.styleMask |= NSWindowStyleMaskClosable;
    [self layoutWindow];
    record(@"stalled", @{ @"visible": @(self.window.visible), @"detail": self.detail.stringValue,
      @"installed": @(self.opening), @"closeButton": @YES });
  }
}
- (BOOL)windowShouldClose:(NSWindow *)window {
  record(@"dismissed", nil);
  [NSApp terminate:nil];
  return YES;
}
@end

int main(int argc, const char **argv) { @autoreleasepool {
  // Inspect the same native policy without presenting a window or taking the
  // user's desktop. Actual background presentation is exercised separately.
  if (argc == 3 && strcmp(argv[1], "--window-policy") == 0) {
    if (strcmp(argv[2], "normal") != 0 && strcmp(argv[2], "background") != 0) return 64;
    WindowPolicy policy = windowPolicy(strcmp(argv[2], "background") == 0);
    NSData *json = [NSJSONSerialization dataWithJSONObject:@{
      @"level": @(policy.level),
      @"allSpaces": @((BOOL)((policy.collection & NSWindowCollectionBehaviorCanJoinAllSpaces) != 0)),
      @"fullScreenAuxiliary": @((BOOL)((policy.collection & NSWindowCollectionBehaviorFullScreenAuxiliary) != 0)),
      @"closeButton": @((BOOL)((policy.style & NSWindowStyleMaskClosable) != 0))
    } options:0 error:nil];
    puts([[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding].UTF8String);
    return 0;
  }
  // Only bounded, local observation inputs. The installer itself stays native.
  if (argc != 6) return 64;
  UpdateStatus *status = [UpdateStatus new];
  status.bundlePath = @(argv[1]); status.bootPath = @(argv[2]); status.version = @(argv[3]);
  status.requested = [NSDate dateWithTimeIntervalSince1970:atof(argv[4]) / 1000];
  const char *background = getenv("DNAFORGE_BACKGROUND_WINDOW");
  status.background = strcmp(argv[5], "background") == 0 ||
    (background && strcmp(background, "1") == 0);
  if (![status.bundlePath isAbsolutePath] || ![status.bundlePath hasSuffix:@".app"] ||
      ![status.bootPath isAbsolutePath] || ![status.bootPath hasSuffix:@"/logs/main-boot.log"] ||
      !status.version.length || !isfinite(status.requested.timeIntervalSince1970)) return 64;
  // Main can append a cancellation independently. Never let our inherited
  // descriptor's older offset overwrite that entry; each event is one write.
  int receiptFlags = fcntl(3, F_GETFL);
  if (receiptFlags < 0 || fcntl(3, F_SETFL, receiptFlags | O_APPEND) < 0) return 74;
  [NSApplication sharedApplication];
  [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
  NSApp.delegate = status;
  [NSApp run];
  return 0;
}}
