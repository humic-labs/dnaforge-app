#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

static void PrintJSON(NSDictionary *payload) {
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:0 error:&error];
  if (data == nil) {
    fprintf(stderr, "%s\n", error.localizedDescription.UTF8String);
    return;
  }
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
}

static int PrintHandlerForType(UTType *contentType) {
  if (contentType == nil) {
    PrintJSON(@{ @"ok": @NO, @"error": @"Unknown content type." });
    return 2;
  }
  NSURL *applicationURL =
      [[NSWorkspace sharedWorkspace] URLForApplicationToOpenContentType:contentType];
  if (applicationURL == nil) {
    PrintJSON(@{ @"ok": @YES, @"handler": [NSNull null] });
    return 0;
  }
  NSBundle *bundle = [NSBundle bundleWithURL:applicationURL];
  NSString *bundleIdentifier = bundle.bundleIdentifier ?: @"";
  NSString *name = [bundle objectForInfoDictionaryKey:@"CFBundleDisplayName"];
  if (name.length == 0) name = [bundle objectForInfoDictionaryKey:@"CFBundleName"];
  if (name.length == 0) name = applicationURL.lastPathComponent.stringByDeletingPathExtension;
  PrintJSON(@{
    @"ok": @YES,
    @"handler": @{
      @"bundleId": bundleIdentifier,
      @"name": name ?: @"",
      @"path": applicationURL.path ?: @""
    }
  });
  return 0;
}

static int QueryHandler(NSString *identifier) {
  return PrintHandlerForType([UTType typeWithIdentifier:identifier]);
}

static int QueryHandlerForExtension(NSString *extension) {
  return PrintHandlerForType([UTType typeWithFilenameExtension:extension]);
}

static int SetHandler(NSString *identifier, NSString *applicationPath) {
  UTType *contentType = [UTType typeWithIdentifier:identifier];
  NSURL *applicationURL = [NSURL fileURLWithPath:applicationPath isDirectory:YES];
  if (contentType == nil || applicationPath.length == 0) {
    PrintJSON(@{ @"ok": @NO, @"error": @"Invalid content type or application path." });
    return 2;
  }

  __block BOOL completed = NO;
  __block NSError *operationError = nil;
  [[NSWorkspace sharedWorkspace]
      setDefaultApplicationAtURL:applicationURL
               toOpenContentType:contentType
               completionHandler:^(NSError *error) {
                 operationError = error;
                 completed = YES;
               }];

  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:15.0];
  while (!completed && deadline.timeIntervalSinceNow > 0) {
    [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                             beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
  }
  if (!completed) {
    PrintJSON(@{ @"ok": @NO, @"error": @"The macOS handler request timed out." });
    return 3;
  }
  if (operationError != nil) {
    PrintJSON(@{ @"ok": @NO, @"error": operationError.localizedDescription ?: @"Request failed." });
    return 4;
  }
  PrintJSON(@{ @"ok": @YES });
  return 0;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 3) {
      fprintf(
          stderr,
          "Usage: dnaforge-file-association query <uti> | query-extension <ext> | set <uti> <app-path>\n"
      );
      return 64;
    }
    NSString *command = [NSString stringWithUTF8String:argv[1]];
    NSString *identifier = [NSString stringWithUTF8String:argv[2]];
    if ([command isEqualToString:@"query"]) return QueryHandler(identifier);
    if ([command isEqualToString:@"query-extension"]) return QueryHandlerForExtension(identifier);
    if ([command isEqualToString:@"set"] && argc == 4) {
      return SetHandler(identifier, [NSString stringWithUTF8String:argv[3]]);
    }
    fprintf(stderr, "Unsupported command.\n");
    return 64;
  }
}
