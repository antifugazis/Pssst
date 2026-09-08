#import <AudioToolbox/AudioToolbox.h>
#import <CoreAudio/CoreAudio.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#import <Foundation/Foundation.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef struct {
    AudioObjectID tap;
    AudioObjectID aggregate;
    AudioUnit unit;
    FILE *file;
    uint64_t bytes;
    BOOL processTap;
} PssstCapture;

static void set_error(char *buffer, size_t length, const char *message) {
    if (!buffer || length == 0) return;
    snprintf(buffer, length, "%s", message ? message : "Core Audio error");
}

static void set_status_error(char *buffer, size_t length, const char *prefix, OSStatus status) {
    if (!buffer || length == 0) return;
    snprintf(buffer, length, "%s (OSStatus %d)", prefix, (int)status);
}

static void write_wav_header(FILE *file, uint32_t dataLength) {
    uint32_t riffLength = 36u + dataLength;
    uint16_t format = 3; // IEEE float
    uint16_t channels = 2;
    uint32_t sampleRate = 48000;
    uint16_t bits = 32;
    uint16_t blockAlign = channels * bits / 8;
    uint32_t byteRate = sampleRate * blockAlign;
    fseek(file, 0, SEEK_SET);
    fwrite("RIFF", 1, 4, file); fwrite(&riffLength, 4, 1, file); fwrite("WAVE", 1, 4, file);
    fwrite("fmt ", 1, 4, file); uint32_t fmtLength = 16; fwrite(&fmtLength, 4, 1, file);
    fwrite(&format, 2, 1, file); fwrite(&channels, 2, 1, file); fwrite(&sampleRate, 4, 1, file);
    fwrite(&byteRate, 4, 1, file); fwrite(&blockAlign, 2, 1, file); fwrite(&bits, 2, 1, file);
    fwrite("data", 1, 4, file); fwrite(&dataLength, 4, 1, file); fseek(file, 0, SEEK_END);
}

static OSStatus render_callback(void *refCon, AudioUnitRenderActionFlags *flags,
                                const AudioTimeStamp *timestamp, UInt32 bus,
                                UInt32 frames, AudioBufferList *ioData) {
    (void)flags; (void)timestamp; (void)bus;
    PssstCapture *capture = (PssstCapture *)refCon;
    if (!capture || !capture->file) return noErr;
    OSStatus status = AudioUnitRender(capture->unit, flags, timestamp, 1, frames, ioData);
    if (status != noErr) return status;
    for (UInt32 index = 0; index < ioData->mNumberBuffers; index++) {
        AudioBuffer *buffer = &ioData->mBuffers[index];
        if (buffer->mData && buffer->mDataByteSize > 0) {
            fwrite(buffer->mData, 1, buffer->mDataByteSize, capture->file);
            capture->bytes += buffer->mDataByteSize;
        }
    }
    return noErr;
}

static AudioObjectID process_object_for_pid(pid_t pid) {
    AudioObjectPropertyAddress address = {
        kAudioHardwarePropertyProcessObjectList, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain
    };
    UInt32 size = 0;
    if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &address, 0, NULL, &size) != noErr || size == 0) return kAudioObjectUnknown;
    AudioObjectID *objects = calloc(1, size);
    if (!objects) return kAudioObjectUnknown;
    OSStatus status = AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &size, objects);
    if (status != noErr) { free(objects); return kAudioObjectUnknown; }
    AudioObjectID result = kAudioObjectUnknown;
    UInt32 count = size / sizeof(AudioObjectID);
    for (UInt32 index = 0; index < count; index++) {
        AudioObjectPropertyAddress pidAddress = {
            kAudioProcessPropertyPID, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain
        };
        pid_t candidate = 0; UInt32 pidSize = sizeof(candidate);
        if (AudioObjectGetPropertyData(objects[index], &pidAddress, 0, NULL, &pidSize, &candidate) == noErr && candidate == pid) {
            result = objects[index]; break;
        }
    }
    free(objects);
    return result;
}

static NSString *tap_uid(AudioObjectID tap) {
    AudioObjectPropertyAddress address = { kAudioTapPropertyUID, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
    CFStringRef uid = NULL; UInt32 size = sizeof(uid);
    if (AudioObjectGetPropertyData(tap, &address, 0, NULL, &size, &uid) != noErr || !uid) return nil;
    return [(__bridge NSString *)uid copy];
}

static int configure_unit(PssstCapture *capture, char *error, size_t errorLength) {
    AudioComponentDescription description = { kAudioUnitType_Output, kAudioUnitSubType_HALOutput, kAudioUnitManufacturer_Apple, 0, 0 };
    AudioComponent component = AudioComponentFindNext(NULL, &description);
    if (!component) { set_error(error, errorLength, "Audio output unit is unavailable"); return -1; }
    OSStatus status = AudioComponentInstanceNew(component, &capture->unit);
    if (status != noErr) { set_status_error(error, errorLength, "Could not create audio output unit", status); return -1; }
    UInt32 enabled = 1, disabled = 0;
    status = AudioUnitSetProperty(capture->unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &enabled, sizeof(enabled));
    if (status != noErr) { set_status_error(error, errorLength, "Could not enable audio input", status); return -1; }
    AudioUnitSetProperty(capture->unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &disabled, sizeof(disabled));
    status = AudioUnitSetProperty(capture->unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &capture->aggregate, sizeof(capture->aggregate));
    if (status != noErr) { set_status_error(error, errorLength, "Could not attach the audio tap device", status); return -1; }
    AURenderCallbackStruct callback = { render_callback, capture };
    status = AudioUnitSetProperty(capture->unit, kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input, 0, &callback, sizeof(callback));
    if (status != noErr) { set_status_error(error, errorLength, "Could not install audio callback", status); return -1; }
    status = AudioUnitInitialize(capture->unit);
    if (status != noErr) { set_status_error(error, errorLength, "Could not initialize audio unit", status); return -1; }
    status = AudioOutputUnitStart(capture->unit);
    if (status != noErr) { set_status_error(error, errorLength, "Could not start audio unit", status); return -1; }
    return 0;
}

int pssst_audio_start(int pid, const char *path, uint64_t *handle, char *error, size_t errorLength) {
    if (!path || !handle) { set_error(error, errorLength, "Invalid audio capture arguments"); return -1; }
    @autoreleasepool {
        PssstCapture *capture = calloc(1, sizeof(PssstCapture));
        if (!capture) { set_error(error, errorLength, "Could not allocate audio capture"); return -1; }
        capture->file = fopen(path, "wb");
        if (!capture->file) { set_error(error, errorLength, strerror(errno)); free(capture); return -1; }
        write_wav_header(capture->file, 0);
        if (pid > 0) {
            AudioObjectID processObject = process_object_for_pid((pid_t)pid);
            if (processObject == kAudioObjectUnknown) { set_error(error, errorLength, "The selected application has no Core Audio process"); fclose(capture->file); free(capture); return -1; }
            CATapDescription *description = [[CATapDescription alloc] initStereoMixdownOfProcesses:@[@(processObject)]];
            description.privateTap = YES; description.name = @"Pssst application audio";
            OSStatus status = AudioHardwareCreateProcessTap(description, &capture->tap);
            if (status != noErr) { set_status_error(error, errorLength, "Could not create application audio tap", status); fclose(capture->file); free(capture); return -1; }
            NSString *uid = tap_uid(capture->tap);
            if (!uid) { set_error(error, errorLength, "Audio tap did not expose a UID"); AudioHardwareDestroyProcessTap(capture->tap); fclose(capture->file); free(capture); return -1; }
            NSString *aggregateUID = [NSString stringWithFormat:@"com.irisla.pssst.tap.%d.%u", getpid(), arc4random()];
            NSDictionary *tapEntry = @{ @"uid": uid };
            NSDictionary *aggregateDescription = @{
                @"uid": aggregateUID, @"name": @"Pssst private audio tap", @"private": @YES,
                @"taps": @[tapEntry], @"tapautostart": @YES
            };
            status = AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)aggregateDescription, &capture->aggregate);
            if (status != noErr) { set_status_error(error, errorLength, "Could not create private audio device", status); AudioHardwareDestroyProcessTap(capture->tap); fclose(capture->file); free(capture); return -1; }
            capture->processTap = YES;
        } else {
            AudioObjectPropertyAddress address = { kAudioHardwarePropertyDefaultInputDevice, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
            UInt32 size = sizeof(capture->aggregate);
            OSStatus status = AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &size, &capture->aggregate);
            if (status != noErr || capture->aggregate == kAudioObjectUnknown) { set_status_error(error, errorLength, "Could not find the default microphone", status); fclose(capture->file); free(capture); return -1; }
        }
        if (configure_unit(capture, error, errorLength) != 0) {
            if (capture->unit) AudioComponentInstanceDispose(capture->unit);
            if (capture->aggregate && capture->processTap) AudioHardwareDestroyAggregateDevice(capture->aggregate);
            if (capture->tap) AudioHardwareDestroyProcessTap(capture->tap);
            fclose(capture->file); free(capture); return -1;
        }
        *handle = (uint64_t)(uintptr_t)capture;
        return 0;
    }
}

int pssst_audio_stop(uint64_t handle, char *error, size_t errorLength) {
    PssstCapture *capture = (PssstCapture *)(uintptr_t)handle;
    if (!capture) return 0;
    if (capture->unit) { AudioOutputUnitStop(capture->unit); AudioUnitUninitialize(capture->unit); AudioComponentInstanceDispose(capture->unit); }
    if (capture->file) { write_wav_header(capture->file, (uint32_t)(capture->bytes > UINT32_MAX ? UINT32_MAX : capture->bytes)); fflush(capture->file); fclose(capture->file); }
    if (capture->aggregate && capture->processTap) AudioHardwareDestroyAggregateDevice(capture->aggregate);
    if (capture->tap) AudioHardwareDestroyProcessTap(capture->tap);
    free(capture); (void)error; (void)errorLength; return 0;
}

int pssst_audio_permission_probe(char *error, size_t errorLength) {
    AudioObjectPropertyAddress address = { kAudioHardwarePropertyDefaultInputDevice, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
    AudioDeviceID device = kAudioObjectUnknown; UInt32 size = sizeof(device);
    OSStatus status = AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &size, &device);
    if (status != noErr || device == kAudioObjectUnknown) { set_status_error(error, errorLength, "No audio device is available", status); return -1; }
    return 0;
}
